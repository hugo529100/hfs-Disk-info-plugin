(function monitorUserPanel() {
  let insertedElement = null;

  const format = (v) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) v /= 1024, i++;
    return v.toFixed(2) + ' ' + u[i];
  };

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
    if (!panel || document.querySelector('#user-disk-info')) return;

    // 移除舊的元素（如果存在）
    if (insertedElement) {
      insertedElement.remove();
    }

    insertedElement = createContainer();
    insertedElement.textContent = '📦 Loading...';
    panel.appendChild(insertedElement);

    let html = '';

    // Disk Info
    const disks = await safeFetch('/~/api/get_disk_spaces');
    if (Array.isArray(disks)) {
      html += '<b>▶Disk space:</b><br>' + disks.map(d => {
        const percent = ((d.free / d.total) * 100).toFixed(1);
        return `${d.name} ${format(d.free)} - ${percent}%`;
      }).join('<br>');
    } else {
      html += '❌ Failed to load disk info';
    }

    // Status Info
    const status = await safeFetch('/~/api/get_status');
    if (status) {
      html += `
<br>

<br>
        <b>▶Status:</b><br>
        Version: ${status.version}<br>
        API: ${status.apiVersion}<br>
        Platform: ${status.platform}<br>
        HTTP: ${status.http?.port} (${status.http?.listening ? 'on' : 'off'})<br>
        HTTPS: ${status.https?.port} (${status.https?.listening ? 'on' : 'off'})<br>
        Base URL: ${status.baseUrl}<br>
        RAM Used: ${format(status.ram)}<br>
        Started: ${new Date(status.started).toLocaleString()}
      `;
    } else {
      html += '<br>❌ Failed to load status info';
    }

    insertedElement.innerHTML = html;
  };

  const observer = new MutationObserver(() => {
    // 當 user-panel 存在且 user-disk-info 不存在時，更新信息
    if (document.querySelector('#user-panel') && !document.querySelector('#user-disk-info')) {
      updateInfo();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 初始檢查
  if (document.querySelector('#user-panel') && !document.querySelector('#user-disk-info')) {
    updateInfo();
  }
})();