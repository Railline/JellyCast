(() => {
    'use strict';

    if (window.__jellyCastLoaded) return;
    window.__jellyCastLoaded = true;

    const text = {
        fr: {
            title: 'Diffuser sur un appareil',
            button: 'Diffuser sur un autre appareil',
            empty: 'Aucun autre appareil compatible connecté à ce compte.',
            loading: 'Recherche des appareils…',
            sent: 'Lecture envoyée vers {device}.',
            error: 'Impossible de transférer la lecture.',
            cancel: 'Annuler'
        },
        en: {
            title: 'Cast to a device',
            button: 'Cast to another device',
            empty: 'No other compatible device is connected to this account.',
            loading: 'Looking for devices…',
            sent: 'Playback sent to {device}.',
            error: 'Playback could not be transferred.',
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

    async function context() {
        const api = apiClient();
        const user = await api.getCurrentUser();
        const sessions = await request('Sessions', {
            query: { ControllableByUserId: user.Id }
        });
        const deviceId = currentDeviceId();
        const source = sessions.find(session => session.DeviceId === deviceId)
            || sessions.find(session => session.NowPlayingItem && belongsToUser(session, user.Id));
        const item = source?.NowPlayingItem;

        if (!source || !item?.Id) throw new Error('No active local playback session');

        const targets = sessions.filter(session =>
            session.Id !== source.Id
            && session.SupportsRemoteControl !== false
            && belongsToUser(session, user.Id));

        return { user, source, item, targets };
    }

    async function transfer(target, playback) {
        const query = {
            playCommand: 'PlayNow',
            itemIds: playback.item.Id,
            startPositionTicks: playback.source.PlayState?.PositionTicks || 0
        };
        if (playback.source.NowPlayingItem?.MediaSourceId) {
            query.mediaSourceId = playback.source.NowPlayingItem.MediaSourceId;
        }

        await request(`Sessions/${encodeURIComponent(target.Id)}/Playing`, {
            method: 'POST',
            query,
            dataType: 'text'
        });

        try {
            await request(`Sessions/${encodeURIComponent(playback.source.Id)}/Playing/Pause`, {
                method: 'POST',
                dataType: 'text'
            });
        } catch (error) {
            console.warn('[JellyCast] Target started, but source could not be paused.', error);
        }
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
            if (!playback.targets.length) {
                const empty = document.createElement('p');
                empty.textContent = strings.empty;
                list.appendChild(empty);
                return;
            }

            playback.targets.forEach(target => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'jellycast-device';
                const name = target.DeviceName || target.Client || 'Jellyfin';
                button.innerHTML = `<span class="material-icons" aria-hidden="true">tv</span>
                    <span><strong></strong><small></small></span>`;
                button.querySelector('strong').textContent = name;
                button.querySelector('small').textContent = target.Client || '';
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        await transfer(target, playback);
                        closeDialog(backdrop);
                        toast(strings.sent.replace('{device}', name));
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
            .jellycast-button { color: inherit; }
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

    function mountButton() {
        const controls = document.querySelector(
            '#videoOsdPage .buttons, .videoOsdBottom .buttons, [data-testid="video-osd-controls"]');
        if (!controls || controls.querySelector('.jellycast-button')) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jellycast-button autoSize paper-icon-button-light';
        button.title = t().button;
        button.setAttribute('aria-label', t().button);
        button.innerHTML = '<span class="xlargePaperIconButton material-icons" aria-hidden="true">cast</span>';
        button.addEventListener('click', openDialog);

        const settings = controls.querySelector('.btnVideoOsdSettings');
        controls.insertBefore(button, settings || null);
    }

    addStyles();
    mountButton();
    new MutationObserver(mountButton).observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    window.JellyCast = { belongsToUser };
})();

