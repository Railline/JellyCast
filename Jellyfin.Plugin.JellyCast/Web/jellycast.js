(() => {
    'use strict';

    if (window.__jellyCastLoaded) return;
    window.__jellyCastLoaded = true;

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

    const t = () => text[(document.documentElement.lang || navigator.language || 'en')
        .toLowerCase().startsWith('fr') ? 'fr' : 'en'];

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

    async function context() {
        const api = apiClient();
        const user = await api.getCurrentUser();
        // Do not ask Jellyfin for only "controllable" sessions here. Some clients
        // (notably Jellyfin Media Player) report active playback while declaring
        // SupportsRemoteControl=false. The server would omit those sessions before
        // JellyCast can apply its stricter same-account filtering.
        const sessions = await request('Sessions');
        const deviceId = currentDeviceId();
        const target = sessions.find(session =>
            session.DeviceId === deviceId && belongsToUser(session, user.Id));
        if (!target) throw new Error('Current device session unavailable');

        const sources = sessions.filter(session =>
            session.Id !== target.Id
            && !isSamePhysicalDevice(session.DeviceId, target.DeviceId)
            && session.NowPlayingItem?.Id
            && belongsToUser(session, user.Id));

        return { user, target, sources };
    }

    async function transfer(source, playback) {
        // Snapshot the position before sending Pause. Native clients may update or
        // replace their session object while processing the command.
        const resumePositionTicks = Number(source.PlayState?.PositionTicks) || 0;

        // Freeze the source first so it cannot advance while the destination loads.
        // Some clients acknowledge this endpoint while ignoring the command; their
        // SupportsRemoteControl flag is used below to report that limitation.
        try {
            await request(`Sessions/${encodeURIComponent(source.Id)}/Playing/Pause`, {
                method: 'POST',
                dataType: 'text'
            });
        } catch (error) {
            console.warn('[JellyCast] Previous device could not be paused.', error);
        }

        const query = {
            playCommand: 'PlayNow',
            itemIds: source.NowPlayingItem.Id,
            startPositionTicks: resumePositionTicks
        };
        if (source.NowPlayingItem?.MediaSourceId) {
            query.mediaSourceId = source.NowPlayingItem.MediaSourceId;
        }

        await request(`Sessions/${encodeURIComponent(playback.target.Id)}/Playing`, {
            method: 'POST',
            query,
            dataType: 'text'
        });

        // Native wrappers may create a second playback session after receiving
        // PlayNow. Wait until any session for the current device reports the item
        // before stopping the old player.
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const sessions = await request('Sessions');
            const started = sessions.some(session =>
                session.DeviceId === playback.target.DeviceId
                && session.NowPlayingItem?.Id === source.NowPlayingItem.Id);
            if (started) break;
            await new Promise(resolve => window.setTimeout(resolve, 350));
        }

        try {
            await request(`Sessions/${encodeURIComponent(source.Id)}/Playing/Stop`, {
                method: 'POST',
                dataType: 'text'
            });
        } catch (error) {
            console.warn('[JellyCast] Local playback started, but the previous device could not be stopped.', error);
        }

        return source.SupportsRemoteControl !== false;
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
        try {
            const playback = await context();
            list.replaceChildren();
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
                    button.disabled = true;
                    try {
                        const sourceWasControlled = await transfer(source, playback);
                        closeDialog(backdrop);
                        toast((sourceWasControlled ? strings.sent : strings.noControl)
                            .replace('{device}', name));
                    } catch (error) {
                        console.error('[JellyCast] Transfer failed.', error);
                        button.disabled = false;
                        toast(strings.error);
                    }
                });
                list.appendChild(button);
            });
        } catch (error) {
            console.error('[JellyCast] Device discovery failed.', error);
            list.textContent = strings.error;
        }
    }

    function addStyles() {
        if (document.getElementById('jellycast-styles')) return;
        const style = document.createElement('style');
        style.id = 'jellycast-styles';
        style.textContent = `
            .jellycast-cast-option { width:100%; }
            .jellycast-dialog { position:fixed; inset:0; z-index:100000; display:grid;
              place-items:center; padding:1rem; background:rgba(0,0,0,.7); opacity:0;
              transition:opacity .15s ease; }
            .jellycast-dialog.open { opacity:1; }
            .jellycast-dialog section { width:min(28rem,100%); max-height:80vh; overflow:auto;
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
            .jellycast-toast { position:fixed; z-index:100001; left:50%; bottom:4rem;
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

    window.JellyCast = { belongsToUser, isSamePhysicalDevice };
})();
