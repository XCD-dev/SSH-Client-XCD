const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('sandboxed preload exposes SSH API and layout-independent Ctrl+C', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  let exposedApi;

  vm.runInNewContext(source, {
    require(moduleName) {
      if (moduleName !== 'electron') throw new Error(`Sandboxed preload cannot require ${moduleName}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            assert.equal(name, 'sshClient');
            exposedApi = api;
          }
        },
        ipcRenderer: { invoke: async () => undefined, on: () => {} },
        webUtils: { getPathForFile: () => '' }
      };
    }
  }, { filename: 'preload.js' });

  assert.equal(typeof exposedApi.onLog, 'function');
  assert.equal(typeof exposedApi.getAppInfo, 'function');
  assert.equal(exposedApi.getPathForFile, undefined);
  assert.equal(exposedApi.terminalControlCharacter({ ctrlKey: true, key: 'с', code: 'KeyC' }), '\x03');
});
