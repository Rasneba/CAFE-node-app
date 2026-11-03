(function () {
    'use strict';

    const root = document.querySelector('[data-kds]');
    if (!root || !window.KDS_INITIAL) return;

    const grid = document.getElementById('kdsGrid');
    const empty = document.getElementById('kdsEmpty');
    const liveDot = document.getElementById('kdsLiveDot');
    const soundButton = root.querySelector('[data-kds-sound]');
    const soundLabel = root.querySelector('[data-sound-label]');
    const canManage = root.getAttribute('data-can-manage') === '1';
    const station = root.getAttribute('data-station') || 'KITCHEN';
    const soundKey = 'kds-sound-' + station;
    const routes = window.KDS_ROUTES || {};
    const csrf = window.KDS_CSRF || '';
    const known = new Set();
    let initialized = false;
    let soundEnabled = localStorage.getItem(soundKey);
    soundEnabled = soundEnabled === null ? root.getAttribute('data-sound') === '1' : soundEnabled === '1';
    let audioCtx = null;

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function statusLabel(status) {
        return String(status || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function ageMinutes(created) {
        const seconds = (Date.now() - new Date(String(created).replace(' ', 'T')).getTime()) / 1000;
        return Math.max(0, Math.floor(seconds / 60));
    }

    function form(action, fields, label, className) {
        let html = '<form method="post" action="' + esc(action) + '">';
        html += '<input type="hidden" name="_token" value="' + esc(csrf) + '">';
        Object.keys(fields).forEach(function (key) {
            html += '<input type="hidden" name="' + esc(key) + '" value="' + esc(fields[key]) + '">';
        });
        html += '<button class="' + esc(className || 'btn btn-sm btn-soft') + '" type="submit">' + esc(label) + '</button></form>';
        return html;
    }

    function itemAction(item) {
        if (item.status === 'PENDING') return form(routes.item, { item_id: item.id, status: 'PREPARING' }, 'Start');
        if (item.status === 'PREPARING') return form(routes.item, { item_id: item.id, status: 'READY' }, 'Ready', 'btn btn-sm btn-brand');
        if (item.status === 'READY') return form(routes.item, { item_id: item.id, status: 'SERVED' }, 'Collected');
        return '';
    }

    function ticketActions(ticket) {
        if (!canManage) return '';
        const statuses = (ticket.items || []).map(function (item) { return item.status; });
        let html = '<div class="kds-actions">';
        if (statuses.indexOf('PENDING') !== -1) html += form(routes.ticket, { ticket_id: ticket.id, status: 'PREPARING' }, 'Start all');
        if (statuses.indexOf('PREPARING') !== -1) html += form(routes.ticket, { ticket_id: ticket.id, status: 'READY' }, 'All ready', 'btn btn-sm btn-brand');
        if (statuses.indexOf('READY') !== -1) html += form(routes.ticket, { ticket_id: ticket.id, status: 'SERVED' }, 'All collected');
        html += form(routes.print, { ticket_id: ticket.id }, 'Print ticket');
        html += '</div>';
        return html;
    }

    function renderTicket(ticket) {
        const age = ageMinutes(ticket.created_at);
        const klass = age >= 20 ? 'late' : (age >= 10 ? 'warn' : '');
        let html = '<article class="kds-card ' + klass + '" data-ticket="' + esc(ticket.id) + '" data-created="' + esc(ticket.created_at) + '">';
        html += '<div class="kds-card-head"><div><strong>' + esc(ticket.ticket_number) + '</strong>';
        html += '<span>' + esc(ticket.order_number);
        if (ticket.table_number) html += ' &middot; Table ' + esc(ticket.table_number);
        html += ' &middot; ' + esc(statusLabel(ticket.order_type));
        if (ticket.waiter_name) html += ' &middot; ' + esc(ticket.waiter_name);
        html += '</span></div>';
        html += '<div class="kds-age"><strong>' + age + 'm</strong>' + badge(ticket.status) + '</div></div>';
        if (ticket.priority) html += '<div class="kds-priority">Priority ticket</div>';
        html += '<div class="kds-items">';
        (ticket.items || []).forEach(function (item) {
            html += '<div class="kds-item"><div class="kds-qty">' + Number(item.quantity) + '&times;</div><div class="kds-item-main">';
            html += '<strong>' + esc(item.name) + '</strong>';
            (item.modifiers || []).forEach(function (modifier) { html += '<span class="kds-mod">+ ' + esc(modifier) + '</span>'; });
            if (item.notes) html += '<span class="kds-note">' + esc(item.notes) + '</span>';
            if (item.seat_number) html += '<span class="kds-seat">Seat ' + Number(item.seat_number) + '</span>';
            html += badge(item.status) + '<div class="kds-item-actions">' + itemAction(item) + '</div>';
            html += '</div></div>';
        });
        if (!ticket.items || !ticket.items.length) html += '<p class="form-hint">No items on this ticket.</p>';
        html += '</div>' + ticketActions(ticket) + '</article>';
        return html;
    }

    function badge(status) {
        const key = String(status || '').toLowerCase();
        const cls = key === 'ready' || key === 'served' ? 'badge-success' : (key === 'preparing' ? 'badge-brand' : (key === 'new' || key === 'pending' ? 'badge-warning' : 'badge-muted'));
        return '<span class="badge-status ' + cls + '">' + esc(statusLabel(status)) + '</span>';
    }

    function render(tickets) {
        tickets = tickets || [];
        grid.innerHTML = tickets.map(renderTicket).join('');
        if (empty) empty.hidden = tickets.length > 0;
        const counts = { NEW: 0, PREPARING: 0, READY: 0 };
        tickets.forEach(function (ticket) { if (counts[ticket.status] !== undefined) counts[ticket.status]++; });
        document.getElementById('kdsNew').textContent = counts.NEW;
        document.getElementById('kdsPreparing').textContent = counts.PREPARING;
        document.getElementById('kdsReady').textContent = counts.READY;
        document.getElementById('kdsActiveCount').textContent = tickets.length;
        document.title = '(' + tickets.length + ') ' + (window.KDS_INITIAL.station === 'BAR' ? 'Bar' : 'Kitchen') + ' display';
    }

    function beep() {
        if (!soundEnabled) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, audioCtx.currentTime);
            osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.18);
            gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.45);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(); osc.stop(audioCtx.currentTime + 0.5);
        } catch (error) { /* audio unavailable */ }
    }

    function syncSoundLabel() {
        if (soundLabel) soundLabel.textContent = soundEnabled ? 'Sound on' : 'Sound off';
    }

    if (soundButton) {
        soundButton.addEventListener('click', function () {
            soundEnabled = !soundEnabled;
            localStorage.setItem(soundKey, soundEnabled ? '1' : '0');
            syncSoundLabel();
            if (soundEnabled) beep();
        });
    }
    syncSoundLabel();

    function detectNew(tickets) {
        let hasNew = false;
        tickets.forEach(function (ticket) {
            if (!known.has(ticket.id)) {
                if (initialized) hasNew = true;
                known.add(ticket.id);
            }
        });
        if (hasNew) beep();
        initialized = true;
    }

    async function poll() {
        try {
            const response = await fetch(routes.feed + '&_=' + Date.now(), { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (data.tickets) {
                detectNew(data.tickets);
                render(data.tickets);
            }
            if (liveDot) liveDot.className = 'kds-live-dot is-live';
        } catch (error) {
            if (liveDot) liveDot.className = 'kds-live-dot is-offline';
        }
    }

    document.addEventListener('click', function () { if (soundEnabled && !audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (error) {} } }, { once: true });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    setInterval(function () {
        const clock = document.getElementById('kdsClock');
        if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const cards = grid.querySelectorAll('[data-ticket]');
        cards.forEach(function (card) {
            const age = ageMinutes(card.getAttribute('data-created'));
            card.classList.toggle('warn', age >= 10 && age < 20);
            card.classList.toggle('late', age >= 20);
        });
    }, 30000);

    detectNew(window.KDS_INITIAL.tickets || []);
    render(window.KDS_INITIAL.tickets || []);
    poll();
    setInterval(poll, 10000);
})();
