// Let each fixture shell close its own ConPTY before Electron disposes the rest.
// Killing all seven live PTYs together can block node-pty on loaded Windows runners.
export async function stopMaterialShells({ state, page, waitFor }) {
  for (const project of (await state()).projects) for (const terminal of project.terminals) {
    if (!terminal.shellReady || terminal.cliActive) continue;
    await page.evaluate(id => window.agentrix.writeTerminal(id, 'exit\r'), terminal.id);
    await waitFor(async () => (await state()).projects.flatMap(value => value.terminals)
      .find(value => value.id === terminal.id)?.status === 'exited', 'material fixture shell exits', 4000);
  }
}
