exports.description = "Displays disk space info in user panel, plus lazy server status (uptime / traffic / IPs)"
exports.version = 1.5
exports.apiRequired = 10.0
exports.frontend_js = 'main.js'
exports.repo = "hugo529100/hfs-Disk-info-plugin"

exports.config = {
    adminOnly: {
        type: 'boolean',
        label: 'Admins only',
        helperText: 'Only show the panel to accounts with admin rights. Turn this off to show it to every visitor.',
        defaultValue: true
    },
    showServerStatus: {
        type: 'boolean',
        label: 'Show server status (uptime / traffic / IPs)',
        defaultValue: true
    },
    statusRefresh: {
        type: 'number',
        label: 'Status refresh (seconds)',
        helperText: 'How often the numbers are refreshed while the panel is open. 0 = only once. Nothing is requested while the panel is closed.',
        min: 0,
        defaultValue: 60,
        frontend: true
    },
    diskCacheMinutes: {
        type: 'number',
        label: 'Disk space cache (minutes)',
        helperText: 'How long the browser reuses the disk numbers before asking the server again. Reading them wakes sleeping drives.',
        min: 1,
        defaultValue: 10,
        frontend: true
    }
}

exports.init = api => {

    // Server stats are cheap (no disk access), but the browser asks for them only when
    // the user panel is open, so a short cache is enough to collapse repeated asks.
    const STATUS_CACHE_MS = 5000
    let statusCache = null
    let statusCacheAt = 0
    let trafficResolved = false
    let traffic = null

    function getTraffic() {
        if (trafficResolved)
            return traffic
        trafficResolved = true
        try {
            const mod = api.require('./throttler')
            if (mod && typeof mod.totalSent?.get === 'function' && typeof mod.totalGot?.get === 'function')
                traffic = mod
        } catch (e) {
            traffic = null
        }
        return traffic
    }

    function uptimeSeconds() {
        try {
            if (typeof process !== 'undefined' && typeof process.uptime === 'function')
                return Math.max(0, Math.round(process.uptime()))
        } catch (e) { /* ignore */ }
        return null
    }

    function countIps() {
        try {
            const connections = api.getConnections() || []
            const ips = new Set()
            for (const conn of connections) {
                if (conn && conn.ip)
                    ips.add(conn.ip)
            }
            return ips.size
        } catch (e) {
            return null
        }
    }

    function readStatus() {
        const now = Date.now()
        if (statusCache && now - statusCacheAt < STATUS_CACHE_MS)
            return statusCache
        const t = getTraffic()
        let sent = null
        let got = null
        if (t) {
            try { sent = Number(t.totalSent.get()) } catch (e) { /* ignore */ }
            try { got = Number(t.totalGot.get()) } catch (e) { /* ignore */ }
        }
        statusCache = {
            ts: now,
            uptime: uptimeSeconds(),
            sent: Number.isFinite(sent) ? sent : null,
            got: Number.isFinite(got) ? got : null,
            ips: countIps()
        }
        statusCacheAt = now
        return statusCache
    }

    function isAdmin(ctx) {
        try {
            const username = api.getCurrentUsername(ctx)
            if (!username) return false
            const account = api.getAccount(username)
            return Boolean(account && account.admin)
        } catch (e) {
            return false
        }
    }

    return {
        customRest: {
            // Gate + data for the panel. The browser asks for this before rendering
            // anything, so a non-admin account never triggers a disk read or sees the block.
            diskInfo_status(_params, ctx) {
                if (api.getConfig('adminOnly') !== false && !isAdmin(ctx))
                    return { allowed: false }
                const stats = api.getConfig('showServerStatus') === false ? null : readStatus()
                return { allowed: true, stats }
            }
        }
    }
}


