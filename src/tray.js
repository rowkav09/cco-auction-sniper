// System tray icon so the app can run out of the way instead of needing a visible terminal --
// right-click for "Open dashboard" / "Quit". Windows-only for now (the icon is a .ico; macOS/
// Linux would want the .png variant and isTemplateIcon, see systray2's README).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
// systray2 is CJS built with `exports.default = SysTray`; Node's native CJS interop hands ESM
// the whole exports object as the default, not .default itself, so unwrap it explicitly.
import systrayPkg from 'systray2';
const SysTray = systrayPkg.default || systrayPkg;
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startTray({ onQuit }) {
  const port = store.settings.port || 8934;
  const url = `http://localhost:${port}`;

  const openItem = { title: 'Open dashboard', tooltip: 'Open the CCO Auction Sniper dashboard', checked: false, enabled: true };
  const quitItem = { title: 'Quit', tooltip: 'Stop the bot and close everything', checked: false, enabled: true };

  const systray = new SysTray({
    menu: {
      icon: path.join(__dirname, '..', 'public', 'icon.ico'),
      title: 'CCO Auction Sniper',
      tooltip: 'CCO Auction Sniper',
      items: [openItem, SysTray.separator, quitItem],
    },
    debug: false,
    copyDir: false,
  });

  systray.onClick((action) => {
    if (action.item === openItem) {
      exec(`start "" "${url}"`);
    } else if (action.item === quitItem) {
      store.log('info', 'quit requested from tray icon');
      systray.kill(false);
      onQuit();
    }
  });

  systray.ready().catch((e) => {
    store.log('warn', `tray icon failed to start (dashboard still works at ${url}): ${e.message}`);
  });

  return systray;
}
