// deployment management commands for customers
// create, list, get, update, close, pause, resume, deposit, logs, events, versions

import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { getApiUrl, getAuthToken, authFetch, formatDate, formatTable, handleApiError } from '../lib/client.js';

export function registerDeployCommands(program: Command) {
  const deploy = program
    .command('deploy')
    .description('manage deployments on the kova network');

  // create deployment from sdl file
  deploy
    .command('create <sdl-file>')
    .description('create a deployment from an SDL file')
    .option('-d, --deposit <amount>', 'initial deposit amount (USD)', parseFloat)
    .option('--backup', 'enable backup for this deployment')
    .action(async (sdlFile: string, options: any) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      if (!existsSync(sdlFile)) {
        console.error(`\nfile not found: ${sdlFile}`);
        process.exit(1);
      }

      let sdl: string;
      try {
        sdl = readFileSync(sdlFile, 'utf8');
      } catch (err: any) {
        console.error(`\nfailed to read file: ${err.message}`);
        process.exit(1);
      }

      if (!sdl.trim()) {
        console.error('\nsdl file is empty');
        process.exit(1);
      }

      console.log('creating deployment...');

      try {
        const body: any = { sdl };
        if (options.deposit) body.initialDeposit = options.deposit;
        if (options.backup) body.backupEnabled = true;

        const res = await authFetch('/api/v1/deployments', {
          method: 'POST',
          body: JSON.stringify(body)
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to create deployment: ${data.error || data.message || 'unknown error'}`);
          if (data.details) console.error('details:', JSON.stringify(data.details, null, 2));
          process.exit(1);
        }

        const d = data.deployment;
        console.log('\ndeployment created successfully');
        console.log('========================================');
        console.log(`id:      ${d.id}`);
        console.log(`version: ${d.version}`);
        console.log(`state:   ${d.state}`);
        console.log(`deposit: $${(d.initialDeposit || 0).toFixed(2)}`);
        console.log(`created: ${formatDate(d.createdAt)}`);
        console.log('========================================');
        console.log('\nwaiting for provider bids...');
        console.log(`run "kova deploy get ${d.id}" to check status`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // list deployments
  deploy
    .command('list')
    .alias('ls')
    .description('list your deployments')
    .option('-s, --state <state>', 'filter by state (active, paused, closed)')
    .option('-l, --limit <n>', 'max results', '20')
    .option('-o, --offset <n>', 'offset for pagination', '0')
    .action(async (options: any) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const params = new URLSearchParams();
        if (options.state) params.set('state', options.state);
        params.set('limit', options.limit);
        params.set('offset', options.offset);

        const res = await authFetch(`/api/v1/deployments?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to list deployments: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        if (data.deployments.length === 0) {
          console.log('\nno deployments found');
          if (options.state) console.log(`(filtered by state: ${options.state})`);
          return;
        }

        console.log('');
        const rows = data.deployments.map((d: any) => ({
          ID: d.id.substring(0, 12) + '...',
          State: d.state,
          Version: `v${d.version}`,
          Created: formatDate(d.createdAt),
          Deposit: `$${(d.initialDeposit || 0).toFixed(2)}`
        }));

        formatTable(rows);

        const p = data.pagination;
        if (p && p.total > rows.length) {
          console.log(`\nshowing ${rows.length} of ${p.total} (page ${Math.floor(p.offset / p.limit) + 1}/${p.pages})`);
        }
      } catch (err) {
        handleApiError(err);
      }
    });

  // get deployment details
  deploy
    .command('get <id>')
    .description('get deployment details')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to get deployment: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        const d = data.deployment;
        console.log('\ndeployment details');
        console.log('========================================');
        console.log(`id:             ${d.id}`);
        console.log(`state:          ${d.state}`);
        console.log(`version:        v${d.version}`);
        console.log(`escrow balance: $${(d.escrowBalance || 0).toFixed(4)}`);
        console.log(`initial deposit:$${(d.initialDeposit || 0).toFixed(2)}`);
        console.log(`created:        ${formatDate(d.createdAt)}`);
        console.log(`updated:        ${formatDate(d.updatedAt)}`);
        if (d.closedAt) console.log(`closed:         ${formatDate(d.closedAt)}`);

        // orders
        if (data.orders && data.orders.length > 0) {
          console.log('\norders:');
          for (const o of data.orders) {
            console.log(`  ${o.id.substring(0, 12)}... | state: ${o.state} | max price: $${o.maxPricePerBlock}/block`);
          }
        }

        // lease
        if (data.lease) {
          const l = data.lease;
          console.log('\nlease:');
          console.log(`  id:         ${l.id}`);
          console.log(`  provider:   ${l.providerId}`);
          console.log(`  node:       ${l.nodeId}`);
          console.log(`  price:      $${l.pricePerBlock}/block`);
          console.log(`  total paid: $${(l.totalPaid || 0).toFixed(4)}`);
          console.log(`  state:      ${l.state}`);
        } else {
          console.log('\nlease: none (waiting for bids)');
        }

        console.log('========================================');
      } catch (err) {
        handleApiError(err);
      }
    });

  // update deployment sdl
  deploy
    .command('update <id> <sdl-file>')
    .description('update deployment manifest from SDL file')
    .action(async (id: string, sdlFile: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      if (!existsSync(sdlFile)) {
        console.error(`\nfile not found: ${sdlFile}`);
        process.exit(1);
      }

      let sdl: string;
      try {
        sdl = readFileSync(sdlFile, 'utf8');
      } catch (err: any) {
        console.error(`\nfailed to read file: ${err.message}`);
        process.exit(1);
      }

      console.log('updating deployment...');

      try {
        const res = await authFetch(`/api/v1/deployments/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ sdl })
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nupdate failed: ${data.error || data.message || 'unknown error'}`);
          process.exit(1);
        }

        const d = data.deployment;
        console.log('\ndeployment updated');
        console.log(`  id:      ${d.id}`);
        console.log(`  version: v${d.version}`);
        console.log(`  state:   ${d.state}`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // close deployment
  deploy
    .command('close <id>')
    .description('close a deployment')
    .option('-y, --yes', 'skip confirmation')
    .action(async (id: string, options: any) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      if (!options.yes) {
        // quick confirmation via stdin
        const confirmed = await promptConfirm(`close deployment ${id.substring(0, 12)}...? (y/n) `);
        if (!confirmed) {
          console.log('cancelled');
          return;
        }
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}`, {
          method: 'DELETE'
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nclose failed: ${data.error || data.message || 'unknown error'}`);
          process.exit(1);
        }

        console.log('\ndeployment closed successfully');
        console.log('any remaining escrow balance will be returned to your account');
      } catch (err) {
        handleApiError(err);
      }
    });

  // pause deployment
  deploy
    .command('pause <id>')
    .description('pause a running deployment')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/pause`, {
          method: 'POST'
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\npause failed: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        console.log('\ndeployment paused');
        console.log(`use "kova deploy resume ${id}" to resume`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // resume deployment
  deploy
    .command('resume <id>')
    .description('resume a paused deployment')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/resume`, {
          method: 'POST'
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nresume failed: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        console.log('\ndeployment resumed');
      } catch (err) {
        handleApiError(err);
      }
    });

  // deposit funds
  deploy
    .command('deposit <id> <amount>')
    .description('add funds to deployment escrow')
    .action(async (id: string, amountStr: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        console.error('\namount must be a positive number');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/deposit`, {
          method: 'POST',
          body: JSON.stringify({ amount })
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\ndeposit failed: ${data.error || data.message || 'unknown error'}`);
          process.exit(1);
        }

        console.log(`\n$${amount.toFixed(2)} deposited to deployment escrow`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // get logs
  deploy
    .command('logs <id>')
    .description('get deployment logs')
    .option('-s, --service <name>', 'filter by service name')
    .option('-l, --limit <n>', 'max log lines', '100')
    .option('--search <query>', 'search log content')
    .option('-f, --follow', 'stream logs in real-time (not yet supported)')
    .action(async (id: string, options: any) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      if (options.follow) {
        console.log('note: real-time log streaming not yet supported in CLI, showing recent logs');
      }

      try {
        const params = new URLSearchParams();
        if (options.service) params.set('service', options.service);
        if (options.search) params.set('search', options.search);
        params.set('limit', options.limit);

        const res = await authFetch(`/api/v1/deployments/${id}/logs?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to get logs: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        if (!data.logs || data.logs.length === 0) {
          console.log('\nno logs found');
          return;
        }

        // print logs in a readable format
        for (const log of data.logs) {
          const ts = new Date(log.timestamp).toISOString().substring(11, 23);
          const svc = log.serviceName ? `[${log.serviceName}]` : '';
          const stream = log.stream === 'stderr' ? ' ERR' : '';
          console.log(`${ts} ${svc}${stream} ${log.logLine}`);
        }

        console.log(`\n--- ${data.logs.length} log lines ---`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // get events
  deploy
    .command('events <id>')
    .description('show deployment events')
    .option('-l, --limit <n>', 'max events', '50')
    .action(async (id: string, options: any) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const params = new URLSearchParams();
        params.set('limit', options.limit);

        const res = await authFetch(`/api/v1/deployments/${id}/events?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to get events: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        if (!data.events || data.events.length === 0) {
          console.log('\nno events found');
          return;
        }

        console.log('\ndeployment events');
        console.log('========================================');
        for (const event of data.events) {
          const ts = formatDate(event.timestamp);
          const msg = event.message || event.type;
          console.log(`${ts}  ${event.type.padEnd(25)} ${msg}`);
        }
        console.log(`\n--- ${data.events.length} events ---`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // get version history
  deploy
    .command('versions <id>')
    .description('show deployment version history')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/versions`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to get versions: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        if (!data.versions || data.versions.length === 0) {
          console.log('\nno version history');
          return;
        }

        console.log(`\ncurrent version: v${data.currentVersion}`);
        console.log('========================================');

        const rows = data.versions.map((v: any) => ({
          Version: `v${v.version}`,
          Description: v.description || '-',
          Created: formatDate(v.createdAt)
        }));

        formatTable(rows);
      } catch (err) {
        handleApiError(err);
      }
    });

  // list bids for a deployment
  deploy
    .command('bids <id>')
    .description('list bids for a deployment')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/bids`);
        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to get bids: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        if (!data.bids || data.bids.length === 0) {
          console.log('\nno bids yet - providers are still evaluating your deployment');
          return;
        }

        console.log(`\n${data.bids.length} bid(s) received`);
        console.log('========================================');

        const rows = data.bids.map((b: any) => ({
          ID: b.id.substring(0, 12) + '...',
          Provider: (b.providerName || b.providerId.substring(0, 12) + '...'),
          Price: `$${b.pricePerBlock}/block`,
          State: b.state,
          Reputation: b.reputation?.score ? `${b.reputation.score}%` : '-'
        }));

        formatTable(rows);
        console.log(`\naccept a bid: kova deploy accept-bid ${id} <bid-id>`);
      } catch (err) {
        handleApiError(err);
      }
    });

  // accept a bid
  deploy
    .command('accept-bid <deployment-id> <bid-id>')
    .description('accept a bid and create a lease')
    .action(async (deploymentId: string, bidId: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      console.log('accepting bid...');

      try {
        const res = await authFetch(`/api/v1/deployments/${deploymentId}/lease`, {
          method: 'POST',
          body: JSON.stringify({ bidId })
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nfailed to accept bid: ${data.error || data.message || 'unknown error'}`);
          process.exit(1);
        }

        const l = data.lease;
        console.log('\nlease created');
        console.log('========================================');
        console.log(`lease id:  ${l.id}`);
        console.log(`provider:  ${l.providerId}`);
        console.log(`node:      ${l.nodeId}`);
        console.log(`price:     $${l.pricePerBlock}/block`);
        console.log(`state:     ${l.state}`);
        console.log('========================================');
        console.log('\nmanifest is being sent to provider. your deployment will be live shortly.');
      } catch (err) {
        handleApiError(err);
      }
    });

  // restart deployment
  deploy
    .command('restart <id>')
    .description('restart a deployment (apply file changes)')
    .action(async (id: string) => {
      const token = getAuthToken();
      if (!token) {
        console.error('\nnot logged in. run "kova auth login" first.');
        process.exit(1);
      }

      try {
        const res = await authFetch(`/api/v1/deployments/${id}/restart`, {
          method: 'POST'
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`\nrestart failed: ${data.error || 'unknown error'}`);
          process.exit(1);
        }

        console.log('\nrestart requested');
        console.log(data.message || 'changes will apply within 10 seconds');
      } catch (err) {
        handleApiError(err);
      }
    });

  return deploy;
}

// simple stdin prompt for confirmation
function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => {
      const answer = data.toString().trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
    // auto-resolve after 30s to avoid hanging
    setTimeout(() => resolve(false), 30000);
  });
}
