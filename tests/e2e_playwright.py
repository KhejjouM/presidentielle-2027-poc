# Test de bout en bout. Prérequis : pip install playwright && playwright install chromium ; site servi sur le port 8000.
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto("http://localhost:8000/index.html")
        await pg.wait_for_timeout(800)
        await pg.fill("#situation", "Je suis locataire, mon loyer augmente et je ne trouve pas de médecin traitant.")
        await pg.click("#submit-btn")
        await pg.wait_for_timeout(1200)
        names = await pg.eval_on_selector_all(".ballot-name", "els => els.map(e => e.textContent)")
        counts = await pg.eval_on_selector_all(".ballot", "els => els.map(e => e.querySelectorAll('.measure').length)")
        titles = await pg.eval_on_selector_all(".measure h4", "els => els.map(e => e.textContent)")
        scores = await pg.eval_on_selector_all(".score-value", "els => els.map(e => e.textContent)")
        print("ordre:", names); print("nb mesures:", counts); print("titres:", titles); print("scores:", scores)
        print("meta:", await pg.text_content("#results-meta"))
        await pg.screenshot(path="/tmp/desktop.png", full_page=False)
        await pg.evaluate("document.querySelector('#results').scrollIntoView()")
        await pg.screenshot(path="/tmp/results.png")
        # mode IA sans clé -> erreur
        await pg.check("input[value=ia]")
        await pg.click("#submit-btn")
        print("erreur IA:", await pg.text_content("#form-error"))
        # mobile
        m = await b.new_page(viewport={"width": 390, "height": 844})
        await m.goto("http://localhost:8000/index.html"); await m.wait_for_timeout(600)
        await m.fill("#situation", "Je vis à la campagne, je dépends de ma voiture et mes factures d'énergie augmentent.")
        await m.click("#submit-btn"); await m.wait_for_timeout(1000)
        await m.screenshot(path="/tmp/mobile.png")
        print("titres mobile:", await m.eval_on_selector_all(".measure h4", "els => els.map(e => e.textContent)"))
        sw = await m.evaluate("document.documentElement.scrollWidth")
        print("scrollWidth mobile:", sw)
        print("erreurs JS:", errors)
        await b.close()
asyncio.run(main())
