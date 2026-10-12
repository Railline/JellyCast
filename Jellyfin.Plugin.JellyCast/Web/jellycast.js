(() => {
    'use strict';

    const clientVersion = '1.0.18.0';
    if (window.__jellyCastLoaded === clientVersion) return;
    window.__jellyCastLoaded = clientVersion;

    const text = {
        fr: {
            title: 'Reprendre la lecture ici',
            button: 'Reprendre ici',
            empty: 'Aucune lecture active sur un autre appareil de ce compte.',
            loading: 'Recherche des lectures actives…',
            sent: 'Lecture récupérée depuis {device}.',
            noControl: 'Lecture reprise, mais {device} refuse les commandes Pause et Stop.',
            error: 'Impossible de récupérer la lecture.',
            cancel: 'Annuler'
        },
        en: {
            title: 'Resume playback here',
            button: 'Resume here',
            empty: 'No active playback was found on another device for this account.',
            loading: 'Looking for active playback…',
            sent: 'Playback retrieved from {device}.',
            noControl: 'Playback resumed, but {device} rejects Pause and Stop commands.',
            error: 'Playback could not be retrieved.',
            cancel: 'Cancel'
        }
    };

    function interfaceLanguage() {
        const locale = document.documentElement.getAttribute?.('lang')
            || document.documentElement.lang
            || navigator.language
            || 'en';
        return String(locale).toLowerCase().startsWith('fr') ? 'fr' : 'en';
    }

    const t = () => text[interfaceLanguage()];

    function errorMessage(strings, error) {
        const status = Number(error?.status || error?.statusCode) || 0;
        return status ? `${strings.error} (HTTP ${status})` : strings.error;
    }

    function apiClient() {
        if (!window.ApiClient) throw new Error('ApiClient unavailable');
        return window.ApiClient;
    }

    async function request(path, options = {}) {
        const api = apiClient();
        return api.ajax({
            type: options.method || 'GET',
            url: api.getUrl(path, options.query),
            dataType: options.dataType || 'json'
        });
    }

    function requestSessions() {
        // Android replaces its web session with a native playback session while a
        // video starts. Always bypass intermediary/browser caches so the Cast dialog
        // sees that replacement immediately.
        return request('Sessions', {
            query: {
                jellyCastVersion: clientVersion,
                jellyCastRequest: Date.now()
            }
        });
    }

    const reportedDiagnostics = new Set();

    function reportDiagnostic(stage, error) {
        const message = String(error?.stack || error?.message || error || 'Unknown error')
            .slice(0, 800);
        const key = `${stage}:${message}`;
        if (reportedDiagnostics.has(key)) return;
        reportedDiagnostics.add(key);

        request('JellyCast/Diagnostics', {
            method: 'POST',
            query: {
                stage,
                message,
                deviceId: currentDeviceId(),
                clientVersion
            },
            dataType: 'text'
        }).catch(() => {});
    }

    async function sendPlayStateCommand(sessionId, command) {
        const api = apiClient();
        if (typeof api.sendPlayStateCommand === 'function') {
            return api.sendPlayStateCommand(sessionId, command);
        }

        return request(`Sessions/${encodeURIComponent(sessionId)}/Playing/${command}`, {
            method: 'POST',
            dataType: 'text'
        });
    }

    async function sendPlayCommand(sessionId, options) {
        const api = apiClient();
        if (typeof api.sendPlayCommand === 'function') {
            return api.sendPlayCommand(sessionId, options);
        }

        return request(`Sessions/${encodeURIComponent(sessionId)}/Playing`, {
            method: 'POST',
            query: options,
            dataType: 'text'
        });
    }

    function localPlaybackManager() {
        // JellyCast runs as an injected script, outside Jellyfin Web's module graph.
        // Reuse the already-loaded playback manager instead of remotely commanding
        // the current session. This is required by Android clients that deliberately
        // publish SupportsRemoteControl=false while still supporting local playback.
        if (window.__jellyCastPlaybackManager) return window.__jellyCastPlaybackManager;

        const chunks = window.webpackChunk;
        if (!Array.isArray(chunks)) throw new Error('Jellyfin module runtime unavailable');

        let webpackRequire;
        chunks.push([[
            `jellycast_${Date.now()}_${Math.random().toString(36).slice(2)}`
        ], {}, runtime => { webpackRequire = runtime; }]);
        if (!webpackRequire?.m) throw new Error('Jellyfin module loader unavailable');

        const moduleId = Object.entries(webpackRequire.m)
            .find(([, factory]) => String(factory)
                .includes('[playbackmanager] onPlaybackError'))?.[0];
        if (!moduleId) throw new Error('Jellyfin playback manager unavailable');

        const moduleExports = webpackRequire(moduleId);
        const manager = Object.values(moduleExports || {}).find(value =>
            value
            && typeof value === 'object'
            && typeof value.play === 'function'
            && typeof value.stop === 'function'
            && typeof value.getPlayerState === 'function');
        if (!manager) throw new Error('Jellyfin playback manager export unavailable');

        window.__jellyCastPlaybackManager = manager;
        return manager;
    }

    async function startLocalPlayback(source, positionTicks) {
        const api = apiClient();
        const options = {
            ids: [source.NowPlayingItem.Id],
            startPositionTicks: positionTicks,
            serverId: typeof api.serverId === 'function'
                ? api.serverId()
                : api.serverInfo?.()?.Id
        };
        if (source.NowPlayingItem?.MediaSourceId) {
            options.mediaSourceId = source.NowPlayingItem.MediaSourceId;
        }

        const result = localPlaybackManager().play(options);
        Promise.resolve(result).catch(error => {
            console.error('[JellyCast] Local playback failed after launch.', error);
            reportDiagnostic('local-playback', error);
        });

        // Jellyfin's local play promise can remain pending across the SPA route
        // change that opens the player. Confirmation is handled by the session poll
        // below, so do not block the handoff on that navigation-scoped promise.
        return true;
    }

    async function createHandoff(source) {
        try {
            const handoff = await request('JellyCast/Handoffs', {
                method: 'POST',
                query: {
                    sourceDeviceId: source.DeviceId,
                    itemId: source.NowPlayingItem.Id
                }
            });
            return handoff?.Id || handoff?.id || null;
        } catch (error) {
            console.warn('[JellyCast] Local-stop handoff could not be created.', error);
            return null;
        }
    }

    async function handoffAcknowledged(handoffId) {
        if (!handoffId) return false;
        try {
            const handoff = await request(`JellyCast/Handoffs/${encodeURIComponent(handoffId)}`);
            return handoff?.Acknowledged === true || handoff?.acknowledged === true;
        } catch (error) {
            console.warn('[JellyCast] Local-stop acknowledgement could not be read.', error);
            return false;
        }
    }

    function isHandoffSourcePlaying(handoff, sessions) {
        const sourceDeviceId = handoff?.SourceDeviceId || handoff?.sourceDeviceId;
        const itemId = handoff?.ItemId || handoff?.itemId;
        if (!sourceDeviceId || !itemId) return false;

        return sessions.some(session =>
            isSamePhysicalDevice(session.DeviceId, sourceDeviceId)
            && session.NowPlayingItem?.Id === itemId);
    }

    async function confirmLocalPlaybackStopped(handoff) {
        if (!handoff) return true;

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            try {
                const sessions = await requestSessions();
                if (!isHandoffSourcePlaying(handoff, sessions)) return true;
            } catch (error) {
                console.warn('[JellyCast] Local playback stop could not be confirmed.', error);
                return false;
            }
            await new Promise(resolve => window.setTimeout(resolve, 200));
        }

        return false;
    }

    async function stopLocalPlayback(handoff) {
        // This button calls playbackManager.stop(currentPlayer), which performs the
        // complete Jellyfin Web/JMP shutdown lifecycle. Calling window.api.player.stop()
        // directly stops MPV but leaves Jellyfin Web believing that the old player is
        // still active, preventing an immediate handoff back to this device.
        const stopButton = document.querySelector('.nowPlayingBar .stopButton');
        if (stopButton) {
            try {
                stopButton.click();
                if (await confirmLocalPlaybackStopped(handoff)) return true;
            } catch (error) {
                console.warn('[JellyCast] Jellyfin playback manager could not stop locally.', error);
            }
        }

        // Android playback runs outside Jellyfin Web and may not have a current web
        // player for the stop button. Its native bridge is therefore the safe fallback.
        try {
            if (typeof window.NativePlayer?.stopPlayer === 'function') {
                await Promise.resolve(window.NativePlayer.stopPlayer());
                return await confirmLocalPlaybackStopped(handoff);
            }
        } catch (error) {
            console.warn('[JellyCast] Android native player could not be stopped locally.', error);
        }

        return false;
    }

    const processingHandoffs = new Set();

    async function pollLocalHandoffs() {
        if (!window.ApiClient) return;
        const deviceId = currentDeviceId();
        if (!deviceId) return;

        try {
            const handoff = await request('JellyCast/Handoffs/Pending', {
                query: { deviceId }
            });
            const handoffId = handoff?.Id || handoff?.id;
            if (!handoffId || processingHandoffs.has(handoffId)) return;

            processingHandoffs.add(handoffId);
            try {
                if (!await stopLocalPlayback(handoff)) return;
                await request(
                    `JellyCast/Handoffs/${encodeURIComponent(handoffId)}/Acknowledge`,
                    {
                        method: 'POST',
                        query: { deviceId },
                        dataType: 'text'
                    });
            } finally {
                processingHandoffs.delete(handoffId);
            }
        } catch (error) {
            // Polling is intentionally quiet while a client reconnects or logs out.
        }
    }

    function belongsToUser(session, userId) {
        if (!session || !userId) return false;
        if (String(session.UserId || '').toLowerCase() === String(userId).toLowerCase()) return true;
        return (session.AdditionalUsers || []).some(
            user => String(user.UserId || '').toLowerCase() === String(userId).toLowerCase());
    }

    function currentDeviceId() {
        const api = apiClient();
        return typeof api.deviceId === 'function' ? api.deviceId() : null;
    }

    function isSamePhysicalDevice(firstId, secondId) {
        if (!firstId || !secondId) return false;
        const first = String(firstId);
        const second = String(secondId);
        return first === second || first.startsWith(second) || second.startsWith(first);
    }

    function targetSessionScore(session, deviceId) {
        let score = 0;
        if (String(session.DeviceId || '') === String(deviceId || '')) score += 100;
        if (session.SupportsRemoteControl === true) score += 20;
        if ((session.PlayableMediaTypes || []).includes('Video')) score += 10;
        if (!session.NowPlayingItem?.Id) score += 1;
        return score;
    }

    async function context() {
        const api = apiClient();
        const user = await api.getCurrentUser();
        // Do not ask Jellyfin for only "controllable" sessions here. Some clients
        // (notably Jellyfin Media Player) report active playback while declaring
        // SupportsRemoteControl=false. The server would omit those sessions before
        // JellyCast can apply its stricter same-account filtering.
        const sessions = await requestSessions();
        const deviceId = currentDeviceId();
        // Android can append the user id to its native session device id while
        // ApiClient.deviceId() keeps the shorter web id. Treat both forms as the
        // same physical destination instead of requiring an exact match.
        // Android exposes both an exact web/UI session and a longer native playback
        // session. The native session cannot receive PlayNow, so prefer the exact,
        // controllable session even when the API returns the native session first.
        const target = sessions
            .filter(session =>
                isSamePhysicalDevice(session.DeviceId, deviceId)
                && belongsToUser(session, user.Id))
            .sort((first, second) =>
                targetSessionScore(second, deviceId)
                - targetSessionScore(first, deviceId))[0];
        if (!target) throw new Error('Current device session unavailable');

        const sources = sessions.filter(session =>
            session.Id !== target.Id
            && !isSamePhysicalDevice(session.DeviceId, target.DeviceId)
            && session.NowPlayingItem?.Id
            && belongsToUser(session, user.Id));

        return { user, target, sources, sessions };
    }

    async function transfer(source, playback) {
        // Snapshot the position before sending Pause. Native clients may update or
        // replace their session object while processing the command.
        const resumePositionTicks = Number(source.PlayState?.PositionTicks) || 0;
        const handoffId = await createHandoff(source);

        // Native wrappers may expose both a web session and a playback session.
        // Pause every session for the source device using Jellyfin's official client
        // helper so the command is serialized exactly as Jellyfin Web expects.
        const relatedSourceSessions = playback.sessions.filter(session =>
            isSamePhysicalDevice(session.DeviceId, source.DeviceId)
            && belongsToUser(session, playback.user.Id));
        const sourceSessionIds = [...new Set([source, ...relatedSourceSessions]
            .map(session => session.Id)
            .filter(Boolean))];
        const pauseResults = await Promise.allSettled(sourceSessionIds.map(sessionId =>
            sendPlayStateCommand(sessionId, 'Pause')));
        if (pauseResults.every(result => result.status === 'rejected')) {
            console.warn('[JellyCast] Previous device could not be paused.', pauseResults);
        }

        const playOptions = {
            PlayCommand: 'PlayNow',
            ItemIds: source.NowPlayingItem.Id,
            StartPositionTicks: resumePositionTicks
        };
        if (source.NowPlayingItem?.MediaSourceId) {
            playOptions.MediaSourceId = source.NowPlayingItem.MediaSourceId;
        }

        try {
            await startLocalPlayback(source, resumePositionTicks);
        } catch (error) {
            // Older or customized Jellyfin Web builds may not expose the bundled
            // playback manager in the standard runtime. Preserve the official
            // remote-session command as a compatibility fallback.
            console.warn('[JellyCast] Local playback path unavailable; using remote command.', error);
            await sendPlayCommand(playback.target.Id, playOptions);
        }

        // Native wrappers may create a second playback session after receiving
        // PlayNow. Wait until any session for the current device reports the item
        // before stopping the old player.
        let latestSessions = playback.sessions;
        let targetStarted = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
            try {
                latestSessions = await requestSessions();
                const started = latestSessions.some(session =>
                    isSamePhysicalDevice(session.DeviceId, playback.target.DeviceId)
                    && session.NowPlayingItem?.Id === source.NowPlayingItem.Id);
                if (started) {
                    targetStarted = true;
                    break;
                }
            } catch (error) {
                console.warn('[JellyCast] Could not refresh target playback state.', error);
                break;
            }
            await new Promise(resolve => window.setTimeout(resolve, 350));
        }

        if (!targetStarted) {
            // Never stop the source based solely on an accepted (204) command. Restore
            // it when the destination did not report playback, preventing data loss.
            await Promise.allSettled(sourceSessionIds.map(sessionId =>
                sendPlayStateCommand(sessionId, 'Unpause')));
            throw new Error('Target playback did not start');
        }

        const currentSourceIds = latestSessions
            .filter(session =>
                isSamePhysicalDevice(session.DeviceId, source.DeviceId)
                && belongsToUser(session, playback.user.Id))
            .map(session => session.Id)
            .filter(Boolean);
        const stopSessionIds = [...new Set([...sourceSessionIds, ...currentSourceIds])];
        const stopResults = await Promise.allSettled(stopSessionIds.map(sessionId =>
            sendPlayStateCommand(sessionId, 'Stop')));
        if (stopResults.every(result => result.status === 'rejected')) {
            console.warn('[JellyCast] Local playback started, but the previous device could not be stopped.', stopResults);
        }

        // A 204 response only means Jellyfin accepted the command. Confirm that the
        // old device really stopped instead of trusting SupportsRemoteControl.
        const stopDeadline = Date.now() + 8000;
        while (Date.now() < stopDeadline) {
            try {
                if (await handoffAcknowledged(handoffId)) return true;
                const sessions = await requestSessions();
                const stillPlaying = sessions.some(session =>
                    isSamePhysicalDevice(session.DeviceId, source.DeviceId)
                    && session.NowPlayingItem?.Id === source.NowPlayingItem.Id);
                if (!stillPlaying) return true;
            } catch (error) {
                console.warn('[JellyCast] Could not confirm that the previous device stopped.', error);
                break;
            }
            await new Promise(resolve => window.setTimeout(resolve, 350));
        }

        return false;
    }

    function toast(message) {
        if (window.Dashboard?.alert) {
            window.Dashboard.alert(message);
            return;
        }
        const node = document.createElement('div');
        node.className = 'jellycast-toast';
        node.textContent = message;
        document.body.appendChild(node);
        setTimeout(() => node.remove(), 3200);
    }

    function closeDialog(dialog) {
        dialog.classList.remove('open');
        setTimeout(() => dialog.remove(), 160);
    }

    function clearElement(element) {
        // Jellyfin Media Player can embed an older Chromium DOM without
        // Element.replaceChildren(). This equivalent works on every supported client.
        while (element.firstChild) element.removeChild(element.firstChild);
    }

    async function openDialog() {
        document.querySelector('.jellycast-dialog')?.remove();
        const strings = t();
        const backdrop = document.createElement('div');
        backdrop.className = 'jellycast-dialog open';
        backdrop.innerHTML = `
            <section role="dialog" aria-modal="true" aria-labelledby="jellycast-title">
                <h2 id="jellycast-title">${strings.title}</h2>
                <div class="jellycast-devices"><p>${strings.loading}</p></div>
                <button type="button" class="jellycast-cancel">${strings.cancel}</button>
            </section>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop || event.target.closest('.jellycast-cancel')) closeDialog(backdrop);
        });

        const list = backdrop.querySelector('.jellycast-devices');
        let renderedSources = null;
        let transferInProgress = false;

        function renderPlayback(playback) {
            const sourceSignature = playback.sources
                .map(source => `${source.Id}:${source.NowPlayingItem?.Id || ''}`)
                .sort()
                .join('|');
            if (sourceSignature === renderedSources) return;
            clearElement(list);
            renderedSources = sourceSignature;

            if (!playback.sources.length) {
                const empty = document.createElement('p');
                empty.textContent = strings.empty;
                list.appendChild(empty);
                return;
            }

            playback.sources.forEach(source => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'jellycast-device';
                const name = source.DeviceName || source.Client || 'Jellyfin';
                button.innerHTML = `<span class="material-icons" aria-hidden="true">tv</span>
                    <span><strong></strong><small></small></span>`;
                button.querySelector('strong').textContent = name;
                button.querySelector('small').textContent =
                    source.NowPlayingItem?.Name || source.Client || '';
                button.addEventListener('click', async () => {
                    transferInProgress = true;
                    button.disabled = true;
                    try {
                        const sourceWasControlled = await transfer(source, playback);
                        closeDialog(backdrop);
                        toast((sourceWasControlled ? strings.sent : strings.noControl)
                            .replace('{device}', name));
                    } catch (error) {
                        console.error('[JellyCast] Transfer failed.', error);
                        transferInProgress = false;
                        button.disabled = false;
                        toast(errorMessage(strings, error));
                    }
                });
                list.appendChild(button);
            });
        }

        async function refreshPlayback() {
            if (!backdrop.classList.contains('open') || transferInProgress) return;
            try {
                renderPlayback(await context());
            } catch (error) {
                console.error('[JellyCast] Device discovery failed.', error);
                reportDiagnostic('device-discovery', error);
                if (renderedSources === null) list.textContent = strings.error;
            }

            if (backdrop.classList.contains('open') && !transferInProgress) {
                window.setTimeout(refreshPlayback, 1000);
            }
        }

        await refreshPlayback();
    }

    function addStyles() {
        if (document.getElementById('jellycast-styles')) return;
        const style = document.createElement('style');
        style.id = 'jellycast-styles';
        style.textContent = `
            .jellycast-cast-option { width:100%; }
            .jellycast-dialog { position:fixed; top:0; right:0; bottom:0; left:0;
              z-index:2147483646; display:flex; align-items:center; justify-content:center;
              box-sizing:border-box; padding:1rem; background:rgba(0,0,0,.7); opacity:0;
              transition:opacity .15s ease; }
            .jellycast-dialog.open { opacity:1; }
            .jellycast-dialog section { position:relative; box-sizing:border-box;
              width:100%; max-width:28rem; max-height:80vh; overflow:auto; margin:auto;
              color:#fff; background:#202020; border-radius:.65rem; padding:1.25rem;
              box-shadow:0 1rem 3rem rgba(0,0,0,.55); }
            .jellycast-dialog h2 { margin:0 0 1rem; font-size:1.35rem; }
            .jellycast-device, .jellycast-cancel { width:100%; border:0; border-radius:.35rem;
              padding:.8rem; margin:.3rem 0; color:#fff; background:#333; cursor:pointer;
              text-align:left; }
            .jellycast-device { display:flex; align-items:center; gap:.8rem; }
            .jellycast-device:hover, .jellycast-device:focus { background:#00a4dc; }
            .jellycast-device:disabled { opacity:.55; cursor:wait; }
            .jellycast-device span:last-child { display:flex; flex-direction:column; }
            .jellycast-device small { opacity:.7; }
            .jellycast-cancel { text-align:center; margin-top:1rem; background:transparent; }
            .jellycast-toast { position:fixed; z-index:2147483647; left:50%; bottom:4rem;
              transform:translateX(-50%); color:#fff; background:#222; border-radius:.35rem;
              padding:.8rem 1rem; box-shadow:0 .3rem 1.5rem #000; }
        `;
        document.head.appendChild(style);
    }

    let castMenuRequestedAt = 0;

    function closeNativeCastMenu(sheet) {
        // dialogHelper owns a wrapper and backdrop around the visible dialog.
        // Trigger its internal close lifecycle so those click-blocking elements
        // are cleaned up as well.
        sheet.classList.add('hide');
        sheet.dispatchEvent(new CustomEvent('_close', {
            bubbles: false,
            cancelable: false
        }));
    }

    function addCastMenuOption() {
        if (Date.now() - castMenuRequestedAt > 5000) return;
        const sheets = [...document.querySelectorAll('.actionSheet')];
        const sheet = sheets.at(-1);
        const scroller = sheet?.querySelector('.actionSheetScroller');
        if (!sheet || !scroller) {
            const prompts = [...document.querySelectorAll('.promptDialog')];
            const prompt = prompts.at(-1);
            const anchor = prompt?.querySelector('.btnRemoteControl, .btnDisconnect');
            if (!prompt || !anchor || prompt.querySelector('.jellycast-cast-option')) return;

            const promptButton = document.createElement('button');
            promptButton.type = 'button';
            promptButton.setAttribute('is', 'emby-button');
            promptButton.className =
                'jellycast-cast-option button-flat promptDialogButton';
            promptButton.textContent = t().button;
            promptButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                closeNativeCastMenu(prompt);
                window.setTimeout(openDialog, 0);
            }, true);
            anchor.parentElement.insertBefore(promptButton, anchor);
            return;
        }

        if (sheet.querySelector('.jellycast-cast-option')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('is', 'emby-button');
        button.className =
            'jellycast-cast-option listItem listItem-button listItem-border actionSheetMenuItem';
        button.innerHTML = `
            <span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent
                material-icons cast_connected" aria-hidden="true"></span>
            <div class="listItemBody actionsheetListItemBody">
                <div class="listItemBodyText actionSheetItemText">${t().button}</div>
            </div>`;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            closeNativeCastMenu(sheet);
            window.setTimeout(openDialog, 0);
        }, true);
        scroller.insertBefore(button, scroller.firstChild);
    }

    addStyles();
    document.addEventListener('click', event => {
        if (event.target.closest('.headerCastButton, .castButton')) {
            castMenuRequestedAt = Date.now();
            window.setTimeout(addCastMenuOption, 0);
        }
    }, true);
    new MutationObserver(addCastMenuOption).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    window.setInterval(pollLocalHandoffs, 750);
    window.setTimeout(pollLocalHandoffs, 0);

    window.JellyCast = {
        clientVersion,
        interfaceLanguage,
        belongsToUser,
        isSamePhysicalDevice,
        context,
        transfer,
        targetSessionScore,
        clearElement,
        stopLocalPlayback,
        localPlaybackManager,
        startLocalPlayback
    };
})();
