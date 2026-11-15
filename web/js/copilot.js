const Copilot = (() => {
  const $ = id => document.getElementById(id);
  const labels = { earthset: 'Open Earthset', mast: 'Preview 10 m mast', delay: 'Open date shortlist', brief: 'Open mission brief' };
  const panel = $('copilot');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Mission Copilot';
  toggle.className = 'primary-action';
  toggle.setAttribute('aria-controls', 'copilot');
  toggle.setAttribute('aria-expanded', 'false');
  document.querySelector('.header-tools').prepend(toggle);
  document.querySelector('.mission-workspace').append(panel);
  let callbacks;
  let busy = false;

  function open(value) {
    panel.hidden = !value;
    document.body.classList.toggle('copilot-open', value);
    toggle.setAttribute('aria-expanded', String(value));
    if (value) {
      $('copilotTitle').tabIndex = -1;
      $('copilotTitle').focus({ preventScroll: true });
    } else { $('copilotAudio').pause(); toggle.focus(); }
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  toggle.onclick = () => open(panel.hidden);
  $('closeCopilot').onclick = () => open(false);
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') open(false); });

  function showResult(result, source, action) {
    $('copilotResult').hidden = false;
    $('copilotSource').textContent = source;
    $('copilotResultTitle').textContent = result.title;
    $('copilotAnswer').textContent = result.text;
    $('copilotEvidence').textContent = result.evidence || '';
    $('copilotCopy').hidden = !result.copy;
    $('copilotCopy').onclick = result.copy ? async () => {
      try { await navigator.clipboard.writeText(result.copy); $('copilotStatus').textContent = 'Mission brief copied.'; }
      catch { $('copilotStatus').textContent = 'Clipboard unavailable. Select and copy the brief text.'; }
    } : null;
    $('copilotVoice').hidden = !result.narration;
    if (!result.narration) $('copilotAudio').pause();
    $('copilotAction').hidden = !action;
    $('copilotAction').textContent = action ? labels[action] : '';
    $('copilotAction').onclick = action ? () => run(action) : null;
  }

  async function run(action) {
    if (busy || !callbacks?.context()) return;
    busy = true;
    $('copilotStatus').textContent = 'Opening mission evidence…';
    try {
      showResult(await callbacks.run(action), 'Guided prompt · Simulation output');
      $('copilotStatus').textContent = 'Mission evidence updated.';
    } catch (error) { $('copilotStatus').textContent = error.message || 'The mission action could not be opened.'; }
    finally { busy = false; }
  }

  async function request(endpoint, data) {
    const response = await fetch('/api/copilot/' + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      signal: AbortSignal.timeout(40000)
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json.error || 'Live OpenAI access is unavailable. Try a guided prompt.');
    }
    return response;
  }

  $('copilotForm').onsubmit = async event => {
    event.preventDefault();
    const context = callbacks?.context();
    const prompt = $('copilotQuestion').value.trim();
    if (busy || !context || !prompt) return;
    busy = true;
    $('copilotAsk').disabled = true;
    $('copilotStatus').textContent = 'Asking OpenAI…';
    try {
      const response = await request('ask', { prompt, context });
      const { answer, action } = await response.json();
      showResult({ title: 'Mission answer', text: answer, evidence: 'Snapshot · ' + callbacks.summary(context) },
        'OpenAI · Model response', Object.hasOwn(labels, action) ? action : null);
      $('copilotStatus').textContent = 'Answer ready.';
    } catch (error) {
      $('copilotStatus').textContent = error.message || 'The request failed. Try a guided prompt.';
    } finally { busy = false; $('copilotAsk').disabled = false; }
  };

  document.querySelectorAll('[data-copilot-action]').forEach(button => {
    button.onclick = () => run(button.dataset.copilotAction);
  });
  const audio = $('copilotAudio');
  audio.addEventListener('error', () => {
    $('voiceStatus').textContent = 'Audio could not load. The transcript is below.';
    $('copilotSpeak').hidden = false;
    audio.hidden = true;
  });
  $('copilotSpeak').onclick = () => {
    audio.src = 'data/earthset-narration.mp3';
    audio.hidden = false;
    $('copilotSpeak').hidden = true;
    $('voiceStatus').textContent = '';
    audio.focus();
  };

  return {
    init(options) {
      callbacks = options;
      fetch('/api/copilot/status').then(response => response.ok ? response.json() : { configured: false })
        .then(({ configured }) => {
          $('copilotMode').textContent = configured ? 'Live OpenAI · Guided prompts available' : 'Guided prompts · Live OpenAI unavailable';
        }).catch(() => { $('copilotMode').textContent = 'Guided prompts · Live OpenAI unavailable'; });
    }
  };
})();
