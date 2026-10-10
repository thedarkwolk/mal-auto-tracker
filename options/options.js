import { getSettings, saveSettings, SITES } from '../src/settings.js';

const $ = (s) => document.querySelector(s);

const redirect = chrome.identity.getRedirectURL();
$('#redirect').textContent = redirect;
$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(redirect);
  $('#copy').textContent = 'Copiado ✓';
});

const settings = await getSettings();
$('#clientId').value = settings.clientId;
$('#clientSecret').value = settings.clientSecret;
$('#toasts').checked = settings.toasts;
$('#mascot').checked = settings.mascot;
$('#threshold').value = Math.round(settings.threshold * 100);
const showThreshold = () => ($('#thresholdLabel').textContent = `${$('#threshold').value}%`);
$('#threshold').addEventListener('input', showThreshold);
showThreshold();

for (const [id, name] of Object.entries(SITES)) {
  const label = document.createElement('label');
  label.className = 'check';
  label.innerHTML = `<input type="checkbox" data-site="${id}">`;
  label.append(name);
  label.querySelector('input').checked = settings.sites[id];
  $('#sites').append(label);
}

$('#save').addEventListener('click', async () => {
  const sites = {};
  for (const input of document.querySelectorAll('[data-site]')) sites[input.dataset.site] = input.checked;
  await saveSettings({
    clientId: $('#clientId').value.trim(),
    clientSecret: $('#clientSecret').value.trim(),
    threshold: Number($('#threshold').value) / 100,
    toasts: $('#toasts').checked,
    mascot: $('#mascot').checked,
    sites,
  });
  $('#saved').hidden = false;
  setTimeout(() => ($('#saved').hidden = true), 2000);
});

async function renderMappings() {
  const { mappings = {} } = await chrome.storage.local.get('mappings');
  const list = $('#mappings');
  list.replaceChildren();
  const entries = Object.entries(mappings);
  if (!entries.length) {
    list.innerHTML = '<li class="muted">Ninguna todavía.</li>';
    return;
  }
  for (const [key, m] of entries) {
    const [site, ...rest] = key.split(':');
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = `${SITES[site] || site}: ${rest.join(':')}`;
    const right = document.createElement('span');
    const a = document.createElement('a');
    a.href = `https://myanimelist.net/anime/${m.malId}`;
    a.target = '_blank';
    a.textContent = m.title + (m.offset ? ` (−${m.offset} eps)` : '');
    const del = document.createElement('button');
    del.className = 'link';
    del.textContent = '✕';
    del.title = 'Olvidar';
    del.onclick = async () => {
      delete mappings[key];
      await chrome.storage.local.set({ mappings });
      renderMappings();
    };
    right.append(a, ' ', del);
    li.append(left, right);
    list.append(li);
  }
}
renderMappings();

$('#clearMappings').addEventListener('click', async () => {
  await chrome.storage.local.remove('mappings');
  renderMappings();
});
