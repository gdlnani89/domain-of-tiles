const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    title: 'Domain of Tiles',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Mostra a janela suavemente quando pronta para evitar flash branco
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else if (!app.isPackaged) {
    // Modo dev executado diretamente
    mainWindow.loadURL('http://localhost:5173').catch(() => {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    });
  } else {
    // Modo de produção empacotado
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Atalhos de teclado no Electron
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F11: Alternar Tela Cheia (Fullscreen)
    if (input.key === 'F11' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }

    // F12: Alternar Developer Tools (útil para diagnósticos)
    if (input.key === 'F12' && input.type === 'keyDown') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
      return;
    }

    // Em produção, bloquear recarregamentos acidentais de página (Ctrl+R, Ctrl+Shift+R, F5)
    if (app.isPackaged) {
      if (
        (input.key === 'F5') ||
        ((input.control || input.meta) && input.key.toLowerCase() === 'r')
      ) {
        event.preventDefault();
      }
    }
  });

  // Configuração do Electron Updater
  setupAutoUpdater();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function setupAutoUpdater() {
  // Força download completo e desativa downloads diferenciais (.blockmap) que travam em 0%
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  // API real do electron-updater 6.x
  autoUpdater.disableDifferentialDownload = true;
  // Compatibilidade com configurações legadas
  if (autoUpdater.differentialDownloadConfig) {
    autoUpdater.differentialDownloadConfig.disabled = true;
  }

  // Logs detalhados para diagnóstico no terminal
  autoUpdater.logger = {
    info: (msg) => console.log('[AutoUpdater INFO]', msg),
    warn: (msg) => console.warn('[AutoUpdater WARN]', msg),
    error: (msg) => console.error('[AutoUpdater ERROR]', msg),
    debug: (msg) => console.log('[AutoUpdater DEBUG]', msg)
  };

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Atualização disponível:', info);
    sendToRenderer('update-available', info);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const rawPercent = Number(progressObj && progressObj.percent);
    const percent = Number.isFinite(rawPercent) ? Math.round(rawPercent) : 0;
    const transferredBytes = (progressObj && progressObj.transferred) || 0;
    const totalBytes = (progressObj && progressObj.total) || 0;
    const bytesPerSecond = (progressObj && progressObj.bytesPerSecond) || 0;
    const transferredMB = (transferredBytes / (1024 * 1024)).toFixed(1);
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
    const speedKB = (bytesPerSecond / 1024).toFixed(0);

    console.log(`[Update] Progresso: ${percent}% (${transferredMB}MB / ${totalMB}MB a ${speedKB} KB/s)`);

    sendToRenderer('update-progress', {
      percent,
      transferred: transferredMB,
      total: totalMB,
      speed: speedKB,
      bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Update] Download concluído com sucesso!', info);
    sendToRenderer('update-downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('[Update ERROR]', err);
    sendToRenderer('update-error', err ? (err.message || String(err)) : 'Erro desconhecido');
  });

  // IPC Handlers para comunicação segura com o renderer
  ipcMain.handle('start-download-update', async () => {
    console.log('[AutoUpdater] Iniciando download do instalador...');
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      console.error('[AutoUpdater] Falha ao iniciar download:', err);
      const message = (err && err.message) || 'Falha ao baixar o arquivo da Release.';
      sendToRenderer('update-error', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('quit-and-install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Em produção, verifica atualizações após 3 segundos
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.warn('[AutoUpdater] Não foi possível verificar atualizações agora:', err.message);
      });
    }, 3000);
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
