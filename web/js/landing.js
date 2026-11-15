// Keep pre-homepage bookmarks working, including scenario and demo links.
const requestedDemo = new URLSearchParams(location.search);
if (requestedDemo.has('demo') || requestedDemo.has('view') || /^#s[a-z2-7]+$/.test(location.hash)) {
  location.replace('navigator.html' + location.search + location.hash);
}
