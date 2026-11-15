// Reuse the original controls and canvases so every view shares one mission state.
const Workspace = (() => {
  const originalNodes = new Map(Array.from(document.querySelectorAll('[id]'), node => [node.id, node]));
  const byId = id => document.getElementById(id) ?? originalNodes.get(id);
  const panel = heading => byId(heading).closest('section');
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (id, title, className = '') => {
    const node = create('button', className, title);
    node.id = id;
    node.type = 'button';
    return node;
  };
  const disclosure = (title, ...children) => {
    const details = create('details', 'workspace-details');
    details.append(create('summary', '', title), ...children);
    return details;
  };
  const views = {
    globe: ['3D Moon', 'hGlobe'],
    lander: ['Lander view', 'hPov'],
    sky: ['Sky view', 'hSky'],
    map: ['2D map', 'hMap']
  };
  const screens = {
    explore: ['Explore', 'Explore the lunar surface', 'Choose a site and see where terrain blocks the Sun or Earth.'],
    compare: ['Compare', 'Compare landing scenarios', 'Review sunlight, contact windows and power side by side.'],
    find: ['Find a window', 'Find a better arrival date', 'Search later start dates for the same site and mission duration.']
  };
  let currentView = 'globe';
  let currentScreen = 'explore';
  const nav = create('nav', 'workspace-nav');
  nav.setAttribute('aria-label', 'Mission workspace');
  const viewNav = create('div', 'view-nav');
  viewNav.setAttribute('role', 'group');
  viewNav.setAttribute('aria-label', 'Lunar visualization');
  const stages = create('div', 'mission-stage');
  const explore = create('div', 'explore-grid');
  const mapColumn = create('div', 'map-column');
  const siteColumn = create('aside', 'site-column');
  const clearance = byId('clearanceDock');
  const sitePanel = panel('hSite');
  const siteDetails = disclosure('Coordinates and site data', ...Array.from(sitePanel.children).slice(2, -1));
  byId('status').before(siteDetails);
  const status = panel('hNow');
  const actions = create('div', 'explore-actions');
  actions.append(button('exploreCompare', 'Save and compare →', 'primary-action'), button('exploreFind', 'Find a better date →'));
  const advanced = disclosure('Mission assumptions and lander power', panel('hSet'), panel('hLander'));
  siteColumn.append(sitePanel, actions, status, advanced);
  mapColumn.append(viewNav);
  for (const [id, [label, heading]] of Object.entries(views)) {
    const target = panel(heading);
    target.id = `view-${id}`;
    const control = button(`show-${id}`, label);
    control.setAttribute('aria-controls', target.id);
    control.onclick = () => showView(id);
    viewNav.append(control);
    mapColumn.append(target);
    const guidance = Array.from(target.children).filter(node =>
      node.matches('.caption, .guide') && !node.id
    );
    if (guidance.length) target.append(disclosure('How to use this view', ...guidance));
  }
  // Keep frequently used camera controls visible and tuck layer choices into disclosures.
  for (const id of ['globeChecks', 'povChecks', 'mapChecks']) {
    const fieldset = byId(id);
    const options = disclosure(id === 'povChecks' ? 'Lander overlays' : 'Map layers');
    fieldset.before(options);
    options.append(fieldset);
  }
  explore.append(mapColumn, siteColumn);
  const results = disclosure('Mission timelines and window summary', panel('hTl'), panel('hWin'));
  const compare = create('div', 'compare-workspace');
  compare.append(panel('hCmp'), results, disclosure('Share and export', panel('hShare')));
  const find = panel('hFind');
  const compareBest = button('findCompare', 'Compare original and best date →', 'primary-action');
  compareBest.disabled = true;
  byId('findUse').after(compareBest);
  const findStatus = create('p', 'caption');
  findStatus.id = 'findStatus';
  findStatus.setAttribute('role', 'status');
  compareBest.parentElement.after(findStatus);
  const method = create('dialog', 'data-dialog');
  method.setAttribute('aria-labelledby', 'methodHeading');
  method.innerHTML = `<header class="row"><h2 id="methodHeading">NASA data and methods</h2><form method="dialog"><button>Close</button></form></header>
    <p><strong>NASA LRO LOLA</strong> elevation data provides the skyline that determines when terrain blocks the Sun or Earth.</p>
    <p><strong>NASA/JPL Horizons</strong> tables provide Sun and Earth directions for preset sites within the bundled date range. The browser calculates positions for other dates and custom coordinates.</p>
    <p><strong>NASA LROC</strong> mosaics provide the surface imagery in the map and globe.</p>
    <p>Potential Deep Space Network (DSN) contact means Earth clears the lunar terrain and the Moon clears a ground station’s elevation cutoff. Station scheduling and radio performance are outside the calculation.</p>
    <ul><li><a href="https://pgda.gsfc.nasa.gov/products/69" target="_blank" rel="noopener noreferrer">NASA LOLA elevation and illumination</a></li>
    <li><a href="https://ssd-api.jpl.nasa.gov/doc/horizons.html" target="_blank" rel="noopener noreferrer">NASA/JPL Horizons</a></li>
    <li><a href="https://data.lroc.im-ldi.com/lroc/rdr_product_select" target="_blank" rel="noopener noreferrer">LROC imagery products</a></li></ul>`;
  // Keep the original educational copy available in the methods dialog.
  method.append(panel('hWhy'));
  const header = document.querySelector('header.top');
  header.classList.add('mission-header');
  const home = create('a', 'wordmark', 'LUNAR MAPS');
  home.href = './';
  home.setAttribute('aria-label', 'Lunar Maps homepage');
  const orbit = create('i', 'brand-orbit');
  orbit.setAttribute('aria-hidden', 'true');
  home.prepend(orbit);
  header.querySelector('h1').replaceChildren(home);
  header.querySelector('p').remove();
  const modes = header.querySelector('.seg');
  const tools = create('div', 'header-tools');
  const methodButton = button('showMethods', 'NASA data & methods');
  methodButton.onclick = () => method.showModal();
  tools.append(methodButton, modes);
  header.append(nav, tools);
  document.querySelector('.jump').remove();

  const intro = create('div', 'mission-intro');
  const title = create('h2', 'screen-title');
  const description = create('p', 'screen-description');
  intro.append(title, description);
  const timebar = document.querySelector('.timebar');
  const siteName = create('strong', 'mission-site', 'Loading site…');
  timebar.firstElementChild.prepend(siteName);
  const mobileSite = button('jumpToSite', 'Landing site ↓', 'mobile-site');
  mobileSite.onclick = () => {
    const picker = byId('site');
    picker.focus({ preventScroll: true });
    siteColumn.scrollIntoView({ block: 'start' });
  };
  siteName.after(mobileSite);
  const playback = create('div', 'panel mission-playback');
  playback.setAttribute('role', 'group');
  playback.setAttribute('aria-label', 'Mission time playback');
  playback.append(...Array.from(timebar.children).slice(1));
  mapColumn.append(playback);
  const jumpHelp = playback.lastElementChild.querySelector('.hint');
  if (jumpHelp) jumpHelp.textContent = 'Next event';
  const screenNodes = { explore, compare, find };
  for (const [id, [label]] of Object.entries(screens)) {
    const control = button(`screen-${id}`, label);
    screenNodes[id].id = `workspace-${id}`;
    control.setAttribute('aria-controls', screenNodes[id].id);
    control.onclick = () => show(id);
    nav.append(control);
  }
  stages.append(...Object.values(screenNodes));
  const layout = document.querySelector('.layout');
  layout.className = 'mission-workspace';
  layout.replaceChildren(intro, timebar, stages);
  document.body.append(method);
  // Show coordinates when a 3D pin is laid down so it can be applied immediately.
  const coordinates = byId('cLat');
  coordinates.addEventListener('input', () => { siteDetails.open = true; });

  function refresh() { requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); }
  function showView(id) {
    currentView = id;
    for (const [name, [, heading]] of Object.entries(views)) {
      panel(heading).hidden = name !== currentView;
      byId(`show-${name}`).setAttribute('aria-pressed', String(name === currentView));
    }
    if (id === 'lander' || id === 'sky') {
      panel(views[id][1]).after(clearance);
      clearance.hidden = false;
    } else {
      mapColumn.append(clearance);
      clearance.hidden = true;
    }
    refresh();
  }
  function show(id) {
    currentScreen = id;
    const [, heading, context] = screens[currentScreen];
    title.textContent = heading;
    description.textContent = context;
    for (const [name, node] of Object.entries(screenNodes)) {
      node.hidden = name !== currentScreen;
      byId(`screen-${name}`).setAttribute('aria-pressed', String(name === currentScreen));
    }
    mobileSite.hidden = id !== 'explore';
    window.scrollTo(0, 0);
    refresh();
  }
  byId('exploreFind').onclick = () => { show('find'); byId('findGoal').focus(); };
  results.addEventListener('toggle', refresh);
  advanced.addEventListener('toggle', refresh);
  document.documentElement.dataset.theme = 'dark';
  showView(currentView);
  show(currentScreen);
  return {
    show,
    showView,
    setSite: name => { if (siteName.textContent !== name) siteName.textContent = name; },
    openCoordinates: () => { siteDetails.open = true; }
  };
})();
