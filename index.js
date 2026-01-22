const MAX_DAYS = 30;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    await loadAllReports();
  } catch (e) {
    console.error('Failed to load status data:', e);
    showError();
  }
}

async function loadAllReports() {
  const response = await fetch('urls.cfg');
  if (!response.ok) throw new Error('Failed to load config');

  const configText = await response.text();
  const lines = configText.split('\n').filter(line => line.trim() && line.includes('='));

  const container = document.getElementById('reports');
  const loading = document.getElementById('loading');

  // Load all services in parallel
  const promises = lines.map(line => {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return null;
    const key = line.substring(0, eqIndex).trim();
    const url = line.substring(eqIndex + 1).trim();
    if (!key || !url) return null;
    return loadServiceReport(key, url);
  }).filter(Boolean);

  const results = await Promise.all(promises);

  // Append all results
  results.forEach(el => {
    if (el) container.appendChild(el);
  });

  // Hide loading
  if (loading) loading.remove();
}

async function loadServiceReport(key, url) {
  const response = await fetch('logs/' + key + '_report.log');
  let logData = '';
  if (response.ok) {
    logData = await response.text();
  }

  const uptimeData = parseLogData(logData);
  return buildServiceCard(key, url, uptimeData);
}

function parseLogData(logText) {
  const rows = logText.split('\n').filter(Boolean);
  const dateMap = {};
  let successCount = 0;
  let totalCount = 0;

  rows.forEach(row => {
    const [dateTimeStr, resultStr] = row.split(',', 2);
    if (!dateTimeStr || !resultStr) return;

    // Parse date - handle various formats
    const dateTime = new Date(Date.parse(dateTimeStr.replace(/-/g, '/') + ' GMT'));
    if (isNaN(dateTime)) return;

    const dateKey = dateTime.toDateString();

    if (!dateMap[dateKey]) {
      dateMap[dateKey] = [];
    }

    const isSuccess = resultStr.trim() === 'success';
    dateMap[dateKey].push(isSuccess ? 1 : 0);

    if (isSuccess) successCount++;
    totalCount++;
  });

  // Convert to relative days
  const now = Date.now();
  const relativeData = {};

  Object.entries(dateMap).forEach(([dateStr, values]) => {
    const daysDiff = Math.floor((now - new Date(dateStr).getTime()) / (24 * 3600 * 1000));
    if (daysDiff < MAX_DAYS) {
      relativeData[daysDiff] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  });

  relativeData.upTime = totalCount > 0
    ? ((successCount / totalCount) * 100).toFixed(2) + '%'
    : '--';

  return relativeData;
}

function buildServiceCard(key, url, uptimeData) {
  const template = document.getElementById('statusContainerTemplate');
  const clone = template.content.cloneNode(true);

  const currentStatus = uptimeData[0];
  const color = getStatusColor(currentStatus);

  // Fill template
  const container = clone.querySelector('.status-service');
  container.querySelector('h2').textContent = formatServiceName(key);
  container.querySelector('.status-badge').className = 'badge status-badge ' + color;
  container.querySelector('.status-badge').textContent = getStatusLabel(color);
  container.querySelector('a').href = url;
  container.querySelector('a').textContent = url;
  container.querySelector('.justify-content-between > span').textContent = uptimeData.upTime + ' uptime (30d)';

  // Build status grid with staggered animation
  const grid = container.querySelector('.status-grid');
  for (let i = MAX_DAYS - 1; i >= 0; i--) {
    const square = buildStatusSquare(key, i, uptimeData[i]);
    // Staggered animation delay (oldest to newest)
    const animIndex = MAX_DAYS - 1 - i;
    square.style.animationDelay = (animIndex * 0.015) + 's';
    grid.appendChild(square);
  }

  return container;
}

function buildStatusSquare(key, daysAgo, uptimeVal) {
  const template = document.getElementById('statusSquareTemplate');
  const clone = template.content.cloneNode(true);
  const square = clone.querySelector('.status-square');

  const color = getStatusColor(uptimeVal);
  square.className = 'status-square ' + color;
  square.dataset.status = color;

  const date = new Date();
  date.setDate(date.getDate() - daysAgo);

  // Event handlers
  const showTip = () => showTooltip(square, date, color);
  square.addEventListener('mouseenter', showTip);
  square.addEventListener('focus', showTip);
  square.addEventListener('mouseleave', hideTooltip);
  square.addEventListener('blur', hideTooltip);

  // Touch support - show on tap, hide on second tap or elsewhere
  let touchActive = false;
  square.addEventListener('touchstart', (e) => {
    if (touchActive) {
      hideTooltip();
      touchActive = false;
    } else {
      e.preventDefault();
      showTip();
      touchActive = true;
    }
  }, { passive: false });

  return square;
}

function getStatusColor(val) {
  if (val == null) return 'nodata';
  if (val >= 1) return 'success';
  if (val < 0.3) return 'failure';
  return 'partial';
}

function getStatusLabel(color) {
  const labels = {
    success: 'Operational',
    partial: 'Degraded',
    failure: 'Outage',
    nodata: 'No Data'
  };
  return labels[color] || 'Unknown';
}

function getStatusDescription(color) {
  const descriptions = {
    success: 'All checks passed on this day.',
    partial: 'Some checks failed on this day.',
    failure: 'Most checks failed on this day.',
    nodata: 'No monitoring data available.'
  };
  return descriptions[color] || '';
}

function formatServiceName(key) {
  // Convert key like "api" to "API", "vaultwarden" to "Vaultwarden", etc.
  if (key.toLowerCase() === 'api') return 'API';
  return key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
}

// Tooltip handling
let tooltipTimer = null;

function showTooltip(element, date, color) {
  clearTimeout(tooltipTimer);

  const tooltip = document.getElementById('tooltip');
  tooltip.querySelector('.tooltip-date').textContent = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });

  const statusEl = tooltip.querySelector('.tooltip-status');
  statusEl.textContent = getStatusLabel(color);
  statusEl.className = 'tooltip-status ' + color;

  tooltip.querySelector('.tooltip-desc').textContent = getStatusDescription(color);

  // Position tooltip
  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = rect.bottom + 8;

  // Keep within viewport
  left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));

  // If would go below viewport, show above
  if (top + tooltipRect.height > window.innerHeight - 10) {
    top = rect.top - tooltipRect.height - 8;
    tooltip.querySelector('.tooltip-arrow').style.cssText = 'top: auto; bottom: -6px; border-bottom: none; border-top: 6px solid #fff;';
  } else {
    tooltip.querySelector('.tooltip-arrow').style.cssText = '';
  }

  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
  tooltip.classList.add('show');
  tooltip.setAttribute('aria-hidden', 'false');
}

function hideTooltip() {
  tooltipTimer = setTimeout(() => {
    const tooltip = document.getElementById('tooltip');
    tooltip.classList.remove('show');
    tooltip.setAttribute('aria-hidden', 'true');
  }, 200);
}

function showError() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = '<p class="text-danger mb-0">Failed to load status data. Please refresh.</p>';
  }
}

// Dismiss tooltip when clicking/tapping outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.status-square') && !e.target.closest('.status-tooltip')) {
    hideTooltip();
  }
});
