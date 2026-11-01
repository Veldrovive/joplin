import BaseCommand from './base-command';
import { _ } from '@joplin/lib/locale';
import Setting from '@joplin/lib/models/Setting';
import Logger, { TargetType } from '@joplin/utils/Logger';
import shim from '@joplin/lib/shim';
import { reg } from '@joplin/lib/registry';
import EmbeddingIndexer from '@joplin/lib/services/ai/EmbeddingIndexer';
import app from './app';
import HeadlessService, { minSyncInterval, parseSyncInterval } from './services/headless/HeadlessService';

const logger = Logger.create('command-server');

interface ServerCommandOptions {
	'exit-early'?: boolean;
	quiet?: boolean;
	service?: boolean;
	'sync-interval'?: number | string;
}

// Leaves time for a supervisor's stop timeout (usually 10 seconds) before it kills the process.
const shutdownTimeout = 9000;

class Command extends BaseCommand {

	public override usage() {
		return 'server <command>';
	}

	public override description() {
		return `${_('Start, stop or check the API server. To specify on which port it should run, set the api.port config variable. Commands are (%s).', ['start', 'stop', 'status'].join('|'))} This is an experimental feature - use at your own risks! It is recommended that the server runs off its own separate profile so that no two CLI instances access that profile at the same time. Use --profile to specify the profile path.`;
	}

	public override options() {
		return [
			['--exit-early', 'Allow the command to exit while the server is still running. The server will still stop when the app exits. Valid only for the `start` subcommand.'],
			['--quiet', 'Log less information to the console. More verbose logs will still be available through log-clipper.txt.'],
			['--service', 'Run as a long-running headless service: in addition to the server, sync at startup, on a timer and after changes, and run the background services (search and AI indexing, decryption, etc.). Logs to stdout and stops cleanly on SIGTERM or SIGINT. Valid only for the `start` subcommand.'],
			['--sync-interval <seconds>', `With --service, the interval between full syncs, in seconds (minimum ${minSyncInterval}). Defaults to the sync.interval config variable, which is not modified.`],
		];
	}

	public override async action(args: { command: string; options: ServerCommandOptions }) {
		const command = args.command;
		const isService = command === 'start' && !!args.options.service;
		const syncInterval = isService ? parseSyncInterval(args.options['sync-interval']) : null;
		const service = isService ? new HeadlessService(app().store(), syncInterval) : null;

		const ClipperServer = require('@joplin/lib/ClipperServer').default;
		ClipperServer.instance().initialize(service ? service.actionApi() : null);
		const stdoutFn = (...s: string[]) => this.stdout(s.join(' '));
		const ignoreOutputFn = () => {};
		const clipperLogger = new Logger();
		clipperLogger.addTarget(TargetType.File, { path: `${Setting.value('profileDir')}/log-clipper.txt` });
		clipperLogger.addTarget(TargetType.Console, { console: {
			info: args.options.quiet ? ignoreOutputFn : stdoutFn,
			warn: args.options.quiet ? ignoreOutputFn : stdoutFn,
			error: stdoutFn,
		} as unknown as Console });
		ClipperServer.instance().setDispatch(() => {});
		ClipperServer.instance().setLogger(clipperLogger);

		const pidPath = `${Setting.value('profileDir')}/clipper-pid.txt`;
		const runningOnPort = await ClipperServer.instance().isRunning();

		if (command === 'start') {
			if (runningOnPort) {
				if (service) throw new Error(_('Server is already running on port %d', runningOnPort));
				this.stdout(_('Server is already running on port %d', runningOnPort));
			} else {
				await shim.fsDriver().writeFile(pidPath, process.pid.toString(), 'utf-8');

				if (service) await this.startService(service, syncInterval);

				const promise = ClipperServer.instance().start();

				if (service && service.hasSyncTarget()) service.requestSyncInBackground();

				if (!args.options['exit-early']) {
					await promise; // Never exit
				}
			}
		} else if (command === 'status') {
			this.stdout(runningOnPort ? _('Server is running on port %d', runningOnPort) : _('Server is not running.'));
		} else if (command === 'stop') {
			if (!runningOnPort) {
				this.stdout(_('Server is not running.'));
				return;
			}
			const pid = await shim.fsDriver().readFile(pidPath);
			if (!pid) return;
			process.kill(pid, 'SIGTERM');
		}
	}

	private async startService(service: HeadlessService, syncInterval: number|null) {
		Logger.globalLogger.addTarget(TargetType.Console, { format: '%(date_time)s: %(level)s: %(prefix)s:' });

		if (syncInterval !== null) reg.setRecurrentSyncIntervalOverride(syncInterval);
		await app().startHeadless();

		let shuttingDown = false;
		const shutdown = async (signal: string) => {
			if (shuttingDown) {
				logger.warn(`Received ${signal} again - exiting immediately`);
				process.exit(1);
			}
			shuttingDown = true;
			logger.info(`Received ${signal} - shutting down`);

			shim.setTimeout(() => {
				logger.error('Shutdown is taking too long - exiting');
				process.exit(1);
			}, shutdownTimeout);

			try {
				const ClipperServer = require('@joplin/lib/ClipperServer').default;
				await ClipperServer.instance().stop();
				await EmbeddingIndexer.instance().stopRunInBackground();
				service.destroy();
			} catch (error) {
				logger.error('Error while shutting down:', error);
			}

			// Cancels any sync in progress and saves the settings before exiting
			await app().exit(0);
		};

		process.on('SIGTERM', () => void shutdown('SIGTERM'));
		process.on('SIGINT', () => void shutdown('SIGINT'));

		logger.info(`Starting headless service. Sync target: ${service.syncTargetName() ?? 'none'}. Sync interval: ${syncInterval ?? Setting.value('sync.interval')} seconds.`);
	}

}

module.exports = Command;
