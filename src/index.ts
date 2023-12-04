// Main

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream, openSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'timers/promises';
import { inspect } from 'node:util';
import { fileURLToPath } from 'url';

import * as core from '@actions/core';
import { Tail } from 'tail';
import got from "got";

const ENV_CACHE_DAEMONDIR = 'MAGIC_NIX_CACHE_DAEMONDIR';

const gotClient = got.extend({
  retry: {
    limit: 5,
    methods: [ 'POST', 'GET', 'PUT', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE' ],
  },
  hooks: {
    beforeRetry: [
      (error, retryCount) => {
        core.info(`Retrying after error ${error.code}, retry #: ${retryCount}`);
      }
    ],
  },
});


function getCacherUrl() : string {
  const runnerArch = process.env.RUNNER_ARCH;
  const runnerOs = process.env.RUNNER_OS;
  const binarySuffix = `${runnerArch}-${runnerOs}`;
  const urlPrefix = `https://install.determinate.systems/magic-nix-cache`;

  if (core.getInput('source-url')) {
    return core.getInput('source-url');
  }

  if (core.getInput('source-tag')) {
    return `${urlPrefix}/tag/${core.getInput('source-tag')}/${binarySuffix}`;
  }

  if (core.getInput('source-pr')) {
    return `${urlPrefix}/pr/${core.getInput('source-pr')}/${binarySuffix}`;
  }

  if (core.getInput('source-branch')) {
    return `${urlPrefix}/branch/${core.getInput('source-branch')}/${binarySuffix}`;
  }

  if (core.getInput('source-revision')) {
    return `${urlPrefix}/rev/${core.getInput('source-revision')}/${binarySuffix}`;
  }

  return `${urlPrefix}/latest/${binarySuffix}`;
}

async function fetchAutoCacher(destination: string) {
  const stream = createWriteStream(destination, {
    encoding: "binary",
    mode: 0o755,
  });

  const binary_url = getCacherUrl();
  core.debug(`Fetching the Magic Nix Cache from ${binary_url}`);

  return pipeline(
    gotClient.stream(binary_url),
    stream
  );
}

async function fileExists(path: string) {
  try {
    await fs.access(path, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
}

async function setUpAutoCache() {
  const tmpdir = process.env['RUNNER_TEMP'] || os.tmpdir();
  const required_env = ['ACTIONS_CACHE_URL', 'ACTIONS_RUNTIME_URL', 'ACTIONS_RUNTIME_TOKEN'];

  var anyMissing = false;
  for (const n of required_env) {
    if (!process.env.hasOwnProperty(n)) {
      anyMissing = true;
      core.warning(`Disabling automatic caching since required environment ${n} isn't available`);
    }
  }

  if (anyMissing) {
    return;
  }

  core.debug(`GitHub Action Cache URL: ${process.env['ACTIONS_CACHE_URL']}`);

  const daemonDir = await fs.mkdtemp(path.join(tmpdir, 'magic-nix-cache-'));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  var daemonBin: string = path.join(__dirname, "../bin/X64-Linux");
  if (await fileExists(daemonBin)) {
  } else if (core.getInput('source-binary')) {
    daemonBin = core.getInput('source-binary');
  } else {
    daemonBin = `${daemonDir}/magic-nix-cache`;
    await fetchAutoCacher(daemonBin);
  }

  var runEnv;
  if (core.isDebug()) {
    runEnv = {
      RUST_LOG: "trace,magic_nix_cache=debug,gha_cache=debug",
      RUST_BACKTRACE: "full",
      ...process.env
    };
  } else {
    runEnv = process.env;
  }

  const outputPath = `${daemonDir}/parent.log`;
  const output = openSync(outputPath, 'a');
  const launch = spawn(
    daemonBin,
    [
      '--daemon-dir', daemonDir,
      '--listen', core.getInput('listen'),
      '--upstream', core.getInput('upstream-cache'),
      '--diagnostic-endpoint', core.getInput('diagnostic-endpoint'),
      '--nix-conf', `${process.env["HOME"]}/.config/nix/nix.conf`
    ].concat(
      core.getInput('use-flakehub') === 'true' ? [
        '--use-flakehub',
        '--attic-server', core.getInput('attic-server'),
        '--flakehub-api-server', core.getInput('flakehub-api-server'),
        '--flakehub-api-server-netrc', path.join(process.env['RUNNER_TEMP'], 'determinate-nix-installer-netrc'),
      ] : []).concat(
        core.getInput('use-gha-cache') === 'true' ? [
          '--use-gha-cache'
        ] : []),
    {
      stdio: ['ignore', output, output],
      env: runEnv
    }
  );

  await new Promise<void>((resolve, reject) => {
    launch.on('exit', async (code, signal) => {
      const log: string = await fs.readFile(outputPath, 'utf-8');
      console.log(log);
      if (signal) {
        reject(new Error(`Daemon was killed by signal ${signal}: ${log}`));
      } else if (code) {
        reject(new Error(`Daemon exited with code ${code}: ${log}`));
      } else {
        resolve();
      }
    });
  });

  core.info('Launched Magic Nix Cache');
  core.exportVariable(ENV_CACHE_DAEMONDIR, daemonDir);
}

async function notifyAutoCache() {
  const daemonDir = process.env[ENV_CACHE_DAEMONDIR];

  if (!daemonDir) {
    return;
  }

  try {
    core.debug(`Indicating workflow start`);
    const res: any = await gotClient.post(`http://${core.getInput('listen')}/api/workflow-start`).json();
    core.debug(`back from post`);
    core.debug(res);
  } catch (e) {
    core.info(`Error marking the workflow as started:`);
    core.info(inspect(e));
    core.info(`Magic Nix Cache may not be running for this workflow.`);
  }
}

async function tearDownAutoCache() {
  const daemonDir = process.env[ENV_CACHE_DAEMONDIR];

  if (!daemonDir) {
    core.debug('magic-nix-cache not started - Skipping');
    return;
  }

  const pidFile = path.join(daemonDir, 'daemon.pid');
  const pid = parseInt(await fs.readFile(pidFile, { encoding: 'ascii' }));
  core.debug(`found daemon pid: ${pid}`);
  if (!pid) {
    throw new Error("magic-nix-cache did not start successfully");
  }

  const log = new Tail(path.join(daemonDir, 'daemon.log'));
  core.debug(`tailing daemon.log...`);
  log.on('line', (line) => {
    core.debug(`got a log line`);
    core.info(line);
  });


  try {
    core.debug(`about to post to localhost`);
    const res: any = await gotClient.post(`http://${core.getInput('listen')}/api/workflow-finish`).json();
    core.debug(`back from post`);
    core.debug(res);
  } finally {
    await setTimeout(5000);

    core.debug(`unwatching the daemon log`);
    log.unwatch();
  }

  core.debug(`killing`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code !== 'ESRCH') {
      throw e;
    }
  }
}

const isPost = !!process.env['STATE_isPost'];

try {
  if (!isPost) {
    core.saveState('isPost', 'true');
    await setUpAutoCache();
    await notifyAutoCache();
  } else {
    await tearDownAutoCache();
  }
} catch (e) {
  core.info(`got an exception:`);
  core.info(e);

  if (!isPost) {
    core.setFailed(e.message);
    throw e;
  } else {
    core.info("not considering this a failure: finishing the upload is optional, anyway.");
    process.exit();
  }}

core.debug(`rip`);

