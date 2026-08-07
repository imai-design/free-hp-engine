const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9378");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("projectcreate"));
  if (!page) { console.log("projectcreateタブなし"); process.exit(1); }
  const input = page.locator('input').first();
  await input.fill("freehp-login", { timeout: 8000 });
  await new Promise(r => setTimeout(r, 2000));
  const body = await page.evaluate(() => document.body.innerText);
  console.log("ID表示:", body.match(/プロジェクト ID[^\n]*/)?.[0] || "(見つからず)");
  await page.screenshot({ path: "shots/mig-1-form.png" });
  process.exit(0);
})().catch(e => { console.error("ERR:", e.message.split("\n")[0]); process.exit(1); });
