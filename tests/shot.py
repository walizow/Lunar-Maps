"""Open the app in headless Chrome, report console errors / network requests, take screenshots."""
import sys, subprocess, time, os
from playwright.sync_api import sync_playwright
web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", web], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/shots"
os.makedirs(out, exist_ok=True)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        for theme, w in (("dark", 1440), ("light", 820)):
            pg = b.new_page(viewport={"width": w, "height": 1000}, color_scheme=theme)
            ext = []
            pg.on("console", lambda m: print("console:", m.type, m.text) if m.type in ("error", "warning") else None)
            pg.on("pageerror", lambda e: print("PAGE ERROR:", e))
            pg.on("request", lambda r: ext.append(r.url) if "localhost:8765" not in r.url else None)
            t = time.time(); pg.goto("http://localhost:8765/navigator.html"); pg.wait_for_selector("#nowCards .card", timeout=20000)
            print(theme, "first usable in %.1f s; external requests: %s" % (time.time() - t, ext or "none"))
            pg.wait_for_timeout(300)
            pg.screenshot(path=f"{out}/{theme}_full.png", full_page=True)
            if theme == "dark":
                pg.click("#skyDial"); pg.wait_for_timeout(900); pg.locator("#sky").screenshot(path=f"{out}/dial.png")
                pg.select_option("#site", "apollo-11"); pg.wait_for_timeout(600); pg.screenshot(path=f"{out}/apollo.png", full_page=True)
                pg.fill("#cLat", "-85.49"); pg.fill("#cLon", "-19.219"); pg.click("#cGo")
                pg.wait_for_function("document.getElementById('site').value==='custom'", timeout=60000); pg.wait_for_timeout(500)
                print("custom site info:", pg.inner_text("#siteInfo").replace("\n", " | "))
                print("window cards:", pg.inner_text("#winCards").replace("\n", " "))
                pg.click("[data-jump=sunset]"); pg.wait_for_timeout(200); print("after jump:", pg.inner_text("#nowText"), "|", pg.inner_text("#nowCards").replace("\n", " ")[:300])
        b.close()
finally:
    srv.terminate()
