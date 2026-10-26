// Helpers for the browser test scripts: open what used to sit on the Data, R & Python, Automate and
// Plugins ribbon tabs (now in the Explorer and Ctrl+K) without depending on where a button is.

/** Run a command by id (`plugins.manage`, `r.console`, `online.osm`...). */
export const runCmd = (page, id) => page.evaluate((id) => window.workbench.command(id), id);

/** Every command id the app knows. */
export const commandIds = (page) => page.evaluate(() => window.workbench.commandIds());

/** Open a plugin tool's dialog through the Toolbox. */
export async function openPluginTool(page, pluginId, toolId) {
  await page.evaluate(([p, t]) => {
    window.workbench.showTab('right', 'toolbox');
    window.toolbox.show(`p:${p}/${t}`);
  }, [pluginId, toolId]);
  await page.click('#toolbox [data-open-plugin]');
}
