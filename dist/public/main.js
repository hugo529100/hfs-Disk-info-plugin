(function monitorUserPanel() {
  'use strict'

  // Two different costs live in this panel:
  //  - disk space: the OS must query every drive, which spins up sleeping HDDs. Read
  //    only while the panel is visible, and cached in the browser for `diskCacheMinutes`.
  //  - server stats (uptime / traffic / IPs): cheap, but still only asked for while the
  //    panel is open, every `statusRefresh` seconds.
  const CACHE_KEY = 'hfs-disk-info:disks:v1'
  const DEFAULTS = { diskCacheMinutes: 10, statusRefresh: 60 }
  const GAP = '&nbsp;&nbsp;'
  const GAP_WIDE = '&nbsp;&nbsp;&nbsp;&nbsp;'

  let insertedElement = null
  let content = null
  let diskState = null
  let statusState = null
  let statsState = null
  let statsHidden = false
  let denied = false
  let fetching = false
  let fetchingStats = false
  let diskRead = false
  let statsTimer = null
  let visibilityObserver = null
  let retryTimer = null
  let retryLeft = 0

  const config = () => {
    const values = { ...cssConfig() }
    try {
      const fromHfs = window.HFS && HFS.getPluginConfig && HFS.getPluginConfig()
      if (fromHfs && typeof fromHfs === 'object') Object.assign(values, fromHfs)
    } catch (err) { /* keep the css values */ }
    return values
  }

  // HFS exposes frontend-enabled settings as CSS variables too; this keeps the knobs
  // working even where getPluginConfig() cannot resolve the calling plugin.
  const cssConfig = () => {
    try {
      const style = getComputedStyle(document.documentElement)
      const num = (name) => {
        const v = style.getPropertyValue(name).trim()
        return v === '' ? undefined : Number(v)
      }
      return {
        statusRefresh: num('--Disk-info-plugin-statusRefresh'),
        diskCacheMinutes: num('--Disk-info-plugin-diskCacheMinutes')
      }
    } catch (err) { return {} }
  }

  // A little breathing room between the ▶ groups, and none after the last one.
  const ensureStyles = () => {
    if (document.getElementById('hfsdi-style')) return
    const style = document.createElement('style')
    style.id = 'hfsdi-style'
    style.textContent = `#user-disk-info .hfsdi-group + .hfsdi-group { margin-top: .4em; }`
    document.head.append(style)
  }

  const diskTtl = () => {
    const n = Number(config().diskCacheMinutes)
    return (isFinite(n) && n > 0 ? n : DEFAULTS.diskCacheMinutes) * 60 * 1000
  }

  const refreshMs = () => {
    const n = Number(config().statusRefresh)
    return Math.round((isFinite(n) && n >= 0 ? n : DEFAULTS.statusRefresh) * 1000)
  }

  const format = (v) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) v /= 1024, i++;
    return v.toFixed(2) + ' ' + u[i];
  };

  const fmtBytes = (bytes) => {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '-'
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let value = bytes
    let i = 0
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
    return value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, '') + ' ' + units[i]
  }

  const fmtUptime = (seconds) => {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '-'
    const s = Math.round(seconds)
    const d = Math.floor(s / 86400)
    const h = Math.floor(s % 86400 / 3600)
    const m = Math.floor(s % 3600 / 60)
    if (d > 0) return d + 'd ' + h + 'h'
    if (h > 0) return h + 'h ' + m + 'm'
    if (m > 0) return m + 'm ' + (s % 60) + 's'
    return s + 's'
  }

  const safeFetch = async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} failed`);
      return await res.json();
    } catch (err) {
      console.error('❌ Error fetching', url, err);
      return null;
    }
  };

  const isVisible = (el) => !!el && el.isConnected && el.getClientRects().length > 0

  const readCache = () => {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.disks) && typeof parsed.ts === 'number') return parsed
    } catch (err) { /* storage may be unavailable */ }
    return null
  }

  const writeCache = (disks) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), disks }))
    } catch (err) { /* storage may be full or blocked */ }
  }

  const group = (html) => `<div class="hfsdi-group">${html}</div>`

  // One block, four ▶ groups: Disk space / Status / Uptime / Transfers.
  // Rendered from whatever data arrived first, so a slow endpoint never blanks the rest.
  const render = () => {
    if (!content) return
    const parts = []

    if (diskState) {
      const body = diskState.error
        ? '❌ Failed to load disk info'
        : diskState.disks.map(d => {
          const percent = d.total ? ((d.free / d.total) * 100).toFixed(1) : '?'
          return `${d.name} ${format(d.free)} - ${percent}%`
        }).join('<br>')
      parts.push(group(`<b>▶Disk space:</b><br>` + body))
    }

    if (statusState) {
      const http = statusState.http || {}
      const https = statusState.https || {}
      parts.push(group(
        `<b>▶Status:</b><br>` +
        `Version: ${statusState.version}${GAP}API: ${statusState.apiVersion}<br>` +
        `HTTP: ${http.port} (${http.listening ? 'on' : 'off'})${GAP}HTTPS: ${https.port} (${https.listening ? 'on' : 'off'})<br>` +
        `Base URL: ${statusState.baseUrl}`
      ))
    }

    if (statsState && !statsHidden) {
      const started = statusState
        ? `<br>Started: ${new Date(statusState.started).toLocaleString()}`
        : ''
      parts.push(group(`<b>▶Uptime:</b> ${fmtUptime(statsState.uptime)}${started}`))

      const transfers = [`<b>▶Transfers:</b>${GAP_WIDE}IPs: ${typeof statsState.ips === 'number' ? statsState.ips : '-'}`]
      transfers.push(`Sent: ${fmtBytes(statsState.sent)} – Got: ${fmtBytes(statsState.got)}`)
      if (statusState)
        transfers.push(`RAM Used: ${format(statusState.ram)}`)
      parts.push(group(transfers.join('<br>')))
    }

    content.innerHTML = parts.join('')
  }

  const loadDisks = async () => {
    if (!content) return
    const cached = readCache()
    if (cached) {
      diskState = { disks: cached.disks }
      content.title = 'disk space: cached ' + new Date(cached.ts).toLocaleTimeString()
      render()
    }
    // Fresh enough: never touch the drives for data we already have.
    if (cached && Date.now() - cached.ts < diskTtl()) return
    if (fetching || !isVisible(content)) return
    fetching = true
    try {
      const disks = await safeFetch('/~/api/get_disk_spaces')
      if (Array.isArray(disks)) {
        writeCache(disks)
        diskState = { disks }
        content.title = 'disk space: read ' + new Date().toLocaleTimeString()
        diskRead = true
        render()
      }
      else if (!cached) {
        diskState = { error: true }
        render()
      }
    }
    finally {
      fetching = false
    }
  }

  // The server decides who may see the panel (admin accounts only, by default).
  const applyStatus = (payload) => {
    if (!payload || payload.allowed === false) return false
    statsState = payload.stats || null
    statsHidden = !payload.stats
    return true
  }

  const deny = () => {
    denied = true
    stopStatsLoop()
    visibilityObserver?.disconnect()
    visibilityObserver = null
    clearTimeout(retryTimer)
    clearInterval(retryTimer)
    insertedElement?.remove()
    insertedElement = null
    content = null
    diskState = statusState = statsState = null
  }

  const fetchStats = async () => {
    if (!content || denied || fetchingStats || !window.HFS || !HFS.customRestCall) return
    fetchingStats = true
    try {
      const payload = await HFS.customRestCall('diskInfo_status', {})
      if (!content) return
      if (!applyStatus(payload)) return deny()
      render()
      if (!statsState) stopStatsLoop()
    } catch (err) {
      /* keep whatever was already shown */
    }
    finally {
      fetchingStats = false
    }
  }

  const fetchStatus = async () => {
    const status = await safeFetch('/~/api/get_status')
    if (!content) return
    statusState = status || null
    render()
  }

  const stopStatsLoop = () => {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null }
  }

  const startStatsLoop = () => {
    if (!content || denied || statsTimer || statsHidden || !isVisible(content)) return
    const ms = refreshMs()
    if (ms <= 0) return
    statsTimer = setInterval(() => {
      if (!isVisible(content)) return stopStatsLoop()
      fetchStats()
    }, ms)
  }

  const createContainer = () => {
    const div = document.createElement('div');
    div.id = 'user-disk-info';
    Object.assign(div.style, {
      marginTop: '0.5em',
      paddingTop: '0.5em',
      borderTop: '1px solid var(--button-text)',
      color: 'inherit',
      fontSize: '12px',
      lineHeight: '1.5',
      fontFamily: 'inherit'
    });
    return div;
  };

  const updateInfo = async () => {
    const panel = document.querySelector('#user-panel');
    if (!panel || denied || document.querySelector('#user-disk-info')) return;

    // 移除舊的元素（如果存在）
    if (insertedElement) {
      insertedElement.remove();
    }

    insertedElement = createContainer();
    content = document.createElement('div')
    insertedElement.append(content)
    panel.appendChild(insertedElement);
    ensureStyles()

    // Ask the server first: only admin accounts may see (and wake) this block.
    let payload = null
    try {
      payload = window.HFS && HFS.customRestCall ? await HFS.customRestCall('diskInfo_status', {}) : null
    } catch (err) { payload = null }
    if (!insertedElement) return
    if (!applyStatus(payload)) return deny()

    render()
    loadDisks()
    fetchStatus()
    startStatsLoop()

    // The panel lives inside a dialog that may still be closed: wait until it is really
    // shown, then read the drives once (delayed, so the dialog paints first).
    if ('IntersectionObserver' in window) {
      visibilityObserver?.disconnect()
      visibilityObserver = new IntersectionObserver(entries => {
        if (!entries.some(e => e.isIntersecting)) return
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          const cached = readCache()
          if (!diskRead && !cached) loadDisks()
          else if (cached) {
            diskState = { disks: cached.disks }
            render()
          }
          startStatsLoop()
        }, 500)
      })
      visibilityObserver.observe(insertedElement)
    }
    else {
      retryLeft = 40
      clearInterval(retryTimer)
      retryTimer = setInterval(() => {
        if (!insertedElement?.isConnected || --retryLeft <= 0) return clearInterval(retryTimer)
        if (!isVisible(insertedElement)) return
        clearInterval(retryTimer)
        loadDisks()
        startStatsLoop()
      }, 500)
    }
  };

  const observer = new MutationObserver(() => {
    if (denied) return
    // 當 user-panel 存在且 user-disk-info 不存在時，更新信息
    if (document.querySelector('#user-panel') && !document.querySelector('#user-disk-info')) {
      updateInfo();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 初始檢查
  if (!denied && document.querySelector('#user-panel') && !document.querySelector('#user-disk-info')) {
    updateInfo();
  }
})();
