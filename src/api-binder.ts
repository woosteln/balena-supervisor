import * as Bluebird from 'bluebird';
import * as bodyParser from 'body-parser';
import * as express from 'express';
import { isLeft } from 'fp-ts/lib/Either';
import * as t from 'io-ts';
import * as _ from 'lodash';
import { PinejsClientRequest, StatusError } from 'pinejs-client-request';
import * as deviceRegister from 'resin-register-device';
import * as url from 'url';

import * as globalEventBus from './event-bus';

import Config, { ConfigType } from './config';
import Database from './db';
import { EventTracker } from './event-tracker';
import { loadBackupFromMigration } from './lib/migration';

import constants = require('./lib/constants');
import {
	ContractValidationError,
	ContractViolationError,
	DuplicateUuidError,
	ExchangeKeyError,
	InternalInconsistencyError,
} from './lib/errors';
import * as request from './lib/request';
import { writeLock } from './lib/update-lock';
import { DeviceStatus, TargetState } from './types/state';

import log from './lib/supervisor-console';

import DeviceState from './device-state';
import Logger from './logger';

// The exponential backoff starts at 15s
const MINIMUM_BACKOFF_DELAY = 15000;

const INTERNAL_STATE_KEYS = [
	'update_pending',
	'update_downloaded',
	'update_failed',
];

export interface APIBinderConstructOpts {
	config: Config;
	// FIXME: Remove this
	db: Database;
	deviceState: DeviceState;
	eventTracker: EventTracker;
	logger: Logger;
}

interface Device {
	id: number;

	[key: string]: unknown;
}

interface DevicePinInfo {
	app: number;
	commit: string;
}

interface DeviceTag {
	id: number;
	name: string;
	value: string;
}

type KeyExchangeOpts = ConfigType<'provisioningOptions'>;

export class APIBinder {
	public router: express.Router;

	private config: Config;
	private deviceState: DeviceState;
	private eventTracker: EventTracker;
	private logger: Logger;

	public balenaApi: PinejsClientRequest | null = null;
	// TODO{type}: Retype me when all types are sorted
	private cachedBalenaApi: PinejsClientRequest | null = null;
	private lastReportedState: DeviceStatus = {
		local: {},
		dependent: {},
	};
	private stateForReport: DeviceStatus = {
		local: {},
		dependent: {},
	};
	private lastTarget: TargetState;
	private lastTargetStateFetch = process.hrtime();
	private reportPending = false;
	private stateReportErrors = 0;
	private targetStateFetchErrors = 0;
	private readyForUpdates = false;

	public constructor({
		config,
		deviceState,
		eventTracker,
		logger,
	}: APIBinderConstructOpts) {
		this.config = config;
		this.deviceState = deviceState;
		this.eventTracker = eventTracker;
		this.logger = logger;

		this.router = this.createAPIBinderRouter(this);
	}

	public async healthcheck() {
		const {
			appUpdatePollInterval,
			unmanaged,
			connectivityCheckEnabled,
		} = await this.config.getMany([
			'appUpdatePollInterval',
			'unmanaged',
			'connectivityCheckEnabled',
		]);

		if (unmanaged) {
			return true;
		}

		if (appUpdatePollInterval == null) {
			return false;
		}

		const timeSinceLastFetch = process.hrtime(this.lastTargetStateFetch);
		const timeSinceLastFetchMs =
			timeSinceLastFetch[0] * 1000 + timeSinceLastFetch[1] / 1e6;
		const stateFetchHealthy = timeSinceLastFetchMs < 2 * appUpdatePollInterval;
		const stateReportHealthy =
			!connectivityCheckEnabled ||
			!this.deviceState.connected ||
			this.stateReportErrors < 3;

		return stateFetchHealthy && stateReportHealthy;
	}

	public async initClient() {
		const {
			unmanaged,
			apiEndpoint,
			currentApiKey,
		} = await this.config.getMany([
			'unmanaged',
			'apiEndpoint',
			'currentApiKey',
		]);

		if (unmanaged) {
			log.debug('Unmanaged mode is set, skipping API client initialization');
			return;
		}

		const baseUrl = url.resolve(apiEndpoint, '/v5/');
		const passthrough = _.cloneDeep(await request.getRequestOptions());
		passthrough.headers =
			passthrough.headers != null ? passthrough.headers : {};
		passthrough.headers.Authorization = `Bearer ${currentApiKey}`;
		this.balenaApi = new PinejsClientRequest({
			apiPrefix: baseUrl,
			passthrough,
		});
		this.cachedBalenaApi = this.balenaApi.clone({}, { cache: {} });
	}

	public async start() {
		const conf = await this.config.getMany([
			'apiEndpoint',
			'unmanaged',
			'bootstrapRetryDelay',
			'initialDeviceName',
		]);
		let { apiEndpoint } = conf;
		const { unmanaged, bootstrapRetryDelay } = conf;

		if (unmanaged) {
			log.info('Unmanaged mode is set, skipping API binder initialization');
			// If we are offline because there is no apiEndpoint, there's a chance
			// we've went through a deprovision. We need to set the initialConfigReported
			// value to '', to ensure that when we do re-provision, we'll report
			// the config and hardward-specific options won't be lost
			if (!apiEndpoint) {
				await this.config.set({ initialConfigReported: '' });
			}
			return;
		}

		log.debug('Ensuring device is provisioned');
		await this.provisionDevice();
		const conf2 = await this.config.getMany([
			'initialConfigReported',
			'apiEndpoint',
		]);
		apiEndpoint = conf2.apiEndpoint;
		const { initialConfigReported } = conf2;

		// Either we haven't reported our initial config or we've been re-provisioned
		if (apiEndpoint !== initialConfigReported) {
			log.info('Reporting initial configuration');
			// We fetch the deviceId here to ensure it's been set
			const deviceId = await this.config.get('deviceId');
			if (deviceId == null) {
				throw new InternalInconsistencyError(
					`Attempt to report initial configuration without a device ID`,
				);
			}
			await this.reportInitialConfig(
				apiEndpoint,
				deviceId,
				bootstrapRetryDelay,
				conf.initialDeviceName ?? undefined,
			);
		}

		log.debug('Starting current state report');
		await this.startCurrentStateReport();

		await loadBackupFromMigration(
			this.deviceState,
			await this.getTargetState(),
			bootstrapRetryDelay,
		);

		this.readyForUpdates = true;
		log.debug('Starting target state poll');
		this.startTargetStatePoll();
	}

	public async fetchDevice(
		uuid: string,
		apiKey: string,
		timeout: number,
	): Promise<Device | null> {
		const reqOpts = {
			resource: 'device',
			options: {
				$filter: {
					uuid,
				},
			},
			passthrough: {
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			},
		};

		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'fetchDevice called without an initialized API client',
			);
		}

		try {
			const res = (await this.balenaApi
				.get(reqOpts)
				.timeout(timeout)) as Device[];
			return res[0];
		} catch (e) {
			return null;
		}
	}

	public async patchDevice(id: number, updatedFields: Dictionary<unknown>) {
		const conf = await this.config.getMany([
			'unmanaged',
			'provisioned',
			'apiTimeout',
		]);

		if (conf.unmanaged) {
			throw new Error('Cannot update device in unmanaged mode');
		}

		if (!conf.provisioned) {
			throw new Error('DEvice must be provisioned to update a device');
		}

		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to patch device without an API client',
			);
		}

		return this.balenaApi
			.patch({
				resource: 'device',
				id,
				body: updatedFields,
			})
			.timeout(conf.apiTimeout);
	}

	public async provisionDependentDevice(device: Device): Promise<Device> {
		const conf = await this.config.getMany([
			'unmanaged',
			'provisioned',
			'apiTimeout',
			'userId',
			'deviceId',
		]);

		if (conf.unmanaged) {
			throw new Error('Cannot provision dependent device in unmanaged mode');
		}
		if (!conf.provisioned) {
			throw new Error(
				'Device must be provisioned to provision a dependent device',
			);
		}
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to provision a dependent device without an API client',
			);
		}

		// TODO: When API supports it as per  https://github.com/resin-io/hq/pull/949 remove userId
		_.defaults(device, {
			belongs_to__user: conf.userId,
			is_managed_by__device: conf.deviceId,
			uuid: deviceRegister.generateUniqueKey(),
			registered_at: Math.floor(Date.now() / 1000),
		});

		return (await this.balenaApi
			.post({ resource: 'device', body: device })
			.timeout(conf.apiTimeout)) as Device;
	}

	public async getTargetState(): Promise<TargetState> {
		const { uuid, apiEndpoint, apiTimeout } = await this.config.getMany([
			'uuid',
			'apiEndpoint',
			'apiTimeout',
		]);

		if (!_.isString(apiEndpoint)) {
			throw new InternalInconsistencyError(
				'Non-string apiEndpoint passed to ApiBinder.getTargetState',
			);
		}
		if (this.cachedBalenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to get target state without an API client',
			);
		}

		const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
		const requestParams = _.extend(
			{ method: 'GET', url: endpoint },
			this.cachedBalenaApi.passthrough,
		);

		return (await this.cachedBalenaApi
			._request(requestParams)
			.timeout(apiTimeout)) as TargetState;
	}

	// TODO: Once 100% typescript, change this to a native promise
	public startTargetStatePoll(): Bluebird<null> {
		return Bluebird.try(() => {
			if (this.balenaApi == null) {
				throw new InternalInconsistencyError(
					'Trying to start poll without initializing API client',
				);
			}
			this.pollTargetState(true);
			return null;
		});
	}

	public startCurrentStateReport() {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Trying to start state reporting without initializing API client',
			);
		}
		this.deviceState.on('change', () => {
			if (!this.reportPending) {
				// A latency of 100ms should be acceptable and
				// allows avoiding catching docker at weird states
				this.reportCurrentState();
			}
		});
		return this.reportCurrentState();
	}

	public async fetchDeviceTags(): Promise<DeviceTag[]> {
		if (this.balenaApi == null) {
			throw new Error(
				'Attempt to communicate with API, without initialized client',
			);
		}
		const tags = (await this.balenaApi.get({
			resource: 'device_tag',
			options: {
				$select: ['id', 'tag_key', 'value'],
			},
		})) as Array<Dictionary<unknown>>;

		return tags.map(tag => {
			// Do some type safe decoding and throw if we get an unexpected value
			const id = t.number.decode(tag.id);
			const name = t.string.decode(tag.tag_key);
			const value = t.string.decode(tag.value);
			if (isLeft(id) || isLeft(name) || isLeft(value)) {
				throw new Error(
					`There was an error parsing device tags from the api. Device tag: ${JSON.stringify(
						tag,
					)}`,
				);
			}
			return {
				id: id.right,
				name: name.right,
				value: value.right,
			};
		});
	}

	private getStateDiff(): DeviceStatus {
		const lastReportedLocal = this.lastReportedState.local;
		const lastReportedDependent = this.lastReportedState.dependent;
		if (lastReportedLocal == null || lastReportedDependent == null) {
			throw new InternalInconsistencyError(
				`No local or dependent component of lastReportedLocal in ApiBinder.getStateDiff: ${JSON.stringify(
					this.lastReportedState,
				)}`,
			);
		}

		const diff = {
			local: _(this.stateForReport.local)
				.omitBy((val, key: keyof DeviceStatus['local']) =>
					_.isEqual(lastReportedLocal[key], val),
				)
				.omit(INTERNAL_STATE_KEYS)
				.value(),
			dependent: _(this.stateForReport.dependent)
				.omitBy((val, key: keyof DeviceStatus['dependent']) =>
					_.isEqual(lastReportedDependent[key], val),
				)
				.omit(INTERNAL_STATE_KEYS)
				.value(),
		};

		return _.omitBy(diff, _.isEmpty);
	}

	private async sendReportPatch(
		stateDiff: DeviceStatus,
		conf: { apiEndpoint: string; uuid: string; localMode: boolean },
	) {
		if (this.cachedBalenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to send report patch without an API client',
			);
		}

		let body = stateDiff;
		if (conf.localMode) {
			body = this.stripDeviceStateInLocalMode(stateDiff);
			// In local mode, check if it still makes sense to send any updates after data strip.
			if (_.isEmpty(body.local)) {
				// Nothing to send.
				return;
			}
		}

		const endpoint = url.resolve(
			conf.apiEndpoint,
			`/device/v2/${conf.uuid}/state`,
		);

		const requestParams = _.extend(
			{
				method: 'PATCH',
				url: endpoint,
				body,
			},
			this.cachedBalenaApi.passthrough,
		);

		await this.cachedBalenaApi._request(requestParams);
	}

	// Returns an object that contains only status fields relevant for the local mode.
	// It basically removes information about applications state.
	public stripDeviceStateInLocalMode(state: DeviceStatus): DeviceStatus {
		return {
			local: _.cloneDeep(
				_.omit(state.local, 'apps', 'is_on__commit', 'logs_channel'),
			),
		};
	}

	private report = _.throttle(async () => {
		const conf = await this.config.getMany([
			'deviceId',
			'apiTimeout',
			'apiEndpoint',
			'uuid',
			'localMode',
		]);

		const stateDiff = this.getStateDiff();
		if (_.size(stateDiff) === 0) {
			return 0;
		}

		const { apiEndpoint, uuid, localMode } = conf;
		if (uuid == null || apiEndpoint == null) {
			throw new InternalInconsistencyError(
				'No uuid or apiEndpoint provided to ApiBinder.report',
			);
		}

		try {
			await Bluebird.resolve(
				this.sendReportPatch(stateDiff, { apiEndpoint, uuid, localMode }),
			).timeout(conf.apiTimeout);

			this.stateReportErrors = 0;
			_.assign(this.lastReportedState.local, stateDiff.local);
			_.assign(this.lastReportedState.dependent, stateDiff.dependent);
		} catch (e) {
			if (e instanceof StatusError) {
				// We don't want this to be classed as a report error, as this will cause
				// the watchdog to kill the supervisor - and killing the supervisor will
				// not help in this situation
				log.error(
					`Non-200 response from the API! Status code: ${e.statusCode} - message:`,
					e,
				);
				log.error(
					`Non-200 response from the API! Status code: ${e.statusCode} - message:`,
					e,
				);
			} else {
				throw e;
			}
		}
	}, constants.maxReportFrequency);

	private reportCurrentState(): null {
		(async () => {
			this.reportPending = true;
			try {
				const currentDeviceState = await this.deviceState.getStatus();
				_.assign(this.stateForReport.local, currentDeviceState.local);
				_.assign(this.stateForReport.dependent, currentDeviceState.dependent);

				const stateDiff = this.getStateDiff();
				if (_.size(stateDiff) === 0) {
					this.reportPending = false;
					return null;
				}

				await this.report();
				this.reportCurrentState();
			} catch (e) {
				this.eventTracker.track('Device state report failure', { error: e });
				// We use the poll interval as the upper limit of
				// the exponential backoff
				const maxDelay = await this.config.get('appUpdatePollInterval');
				const delay = Math.min(
					2 ** this.stateReportErrors * MINIMUM_BACKOFF_DELAY,
					maxDelay,
				);

				++this.stateReportErrors;
				await Bluebird.delay(delay);
				this.reportCurrentState();
			}
		})();
		return null;
	}

	private getAndSetTargetState(force: boolean, isFromApi = false) {
		return Bluebird.using(this.lockGetTarget(), async () => {
			const targetState = await this.getTargetState();
			if (isFromApi || !_.isEqual(targetState, this.lastTarget)) {
				await this.deviceState.setTarget(targetState);
				this.lastTarget = _.cloneDeep(targetState);
				this.deviceState.triggerApplyTarget({ force, isFromApi });
			}
		})
			.tapCatch(ContractValidationError, ContractViolationError, e => {
				log.error(`Could not store target state for device: ${e}`);
				// the dashboard does not display lines correctly,
				// split them explcitly here
				const lines = e.message.split(/\r?\n/);
				lines[0] = `Could not move to new release: ${lines[0]}`;
				for (const line of lines) {
					this.logger.logSystemMessage(line, {}, 'targetStateRejection', false);
				}
			})
			.tapCatch(
				(e: unknown) =>
					!(
						e instanceof ContractValidationError ||
						e instanceof ContractViolationError
					),
				err => {
					log.error(`Failed to get target state for device: ${err}`);
				},
			)
			.finally(() => {
				this.lastTargetStateFetch = process.hrtime();
			});
	}

	private async pollTargetState(isInitialCall: boolean = false): Promise<void> {
		const {
			appUpdatePollInterval,
			instantUpdates,
		} = await this.config.getMany(['appUpdatePollInterval', 'instantUpdates']);

		// We add jitter to the poll interval so that it's between 0.5 and 1.5 times
		// the configured interval
		let pollInterval = (0.5 + Math.random()) * appUpdatePollInterval;

		if (instantUpdates || !isInitialCall) {
			try {
				await this.getAndSetTargetState(false);
				this.targetStateFetchErrors = 0;
			} catch (e) {
				pollInterval = Math.min(
					appUpdatePollInterval,
					15000 * 2 ** this.targetStateFetchErrors,
				);
				++this.targetStateFetchErrors;
			}
		}

		await Bluebird.delay(pollInterval);
		await this.pollTargetState();
	}

	private async pinDevice({ app, commit }: DevicePinInfo) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to pin device without an API client',
			);
		}

		try {
			const deviceId = await this.config.get('deviceId');

			if (deviceId == null) {
				throw new InternalInconsistencyError(
					'Device ID not defined in ApiBinder.pinDevice',
				);
			}

			const release = await this.balenaApi.get({
				resource: 'release',
				options: {
					$filter: {
						belongs_to__application: app,
						commit,
						status: 'success',
					},
					$select: 'id',
				},
			});

			const releaseId = _.get(release, '[0].id');
			if (releaseId == null) {
				throw new Error(
					'Cannot continue pinning preloaded device! No release found!',
				);
			}

			await this.balenaApi.patch({
				resource: 'device',
				id: deviceId,
				body: {
					should_be_running__release: releaseId,
				},
			});

			// Set the config value for pinDevice to null, so that we know the
			// task has been completed
			await this.config.remove('pinDevice');
		} catch (e) {
			log.error(`Could not pin device to release! ${e}`);
			throw e;
		}
	}

	// Creates the necessary config vars in the API to match the current device state,
	// without overwriting any variables that are already set.
	private async reportInitialEnv(
		apiEndpoint: string,
		deviceId: number,
		initialName?: string,
	) {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial environment without an API client',
			);
		}

		const targetConfigUnformatted = _.get(
			await this.getTargetState(),
			'local.config',
		);
		if (targetConfigUnformatted == null) {
			throw new InternalInconsistencyError(
				'Attempt to report initial state with malformed target state',
			);
		}

		const defaultConfig = this.deviceState.deviceConfig.getDefaults();

		const currentState = await this.deviceState.getCurrentForComparison();
		const targetConfig = await this.deviceState.deviceConfig.formatConfigKeys(
			targetConfigUnformatted,
		);

		if (!currentState.local.config) {
			throw new InternalInconsistencyError(
				'No config defined in reportInitialEnv',
			);
		}
		const currentConfig: Dictionary<string> = currentState.local.config;
		for (const [key, value] of _.toPairs(currentConfig)) {
			let varValue = value;
			// We want to disable local mode when joining a cloud
			if (key === 'SUPERVISOR_LOCAL_MODE') {
				varValue = 'false';
			}
			// We never want to disable VPN if, for instance, it failed to start so far
			if (key === 'SUPERVISOR_VPN_CONTROL') {
				varValue = 'true';
			}

			if (targetConfig[key] == null && varValue !== defaultConfig[key]) {
				const envVar = {
					value: varValue,
					device: deviceId,
					name: 'RESIN_' + key,
				};
				await this.balenaApi.post({
					resource: 'device_config_variable',
					body: envVar,
				});
			}
		}

		if (initialName != null) {
			await this.reportInitialName(deviceId, initialName);
		}

		await this.config.set({ initialConfigReported: apiEndpoint });
	}

	private async reportInitialConfig(
		apiEndpoint: string,
		deviceId: number,
		retryDelay: number,
		initialName?: string,
	): Promise<void> {
		try {
			await this.reportInitialEnv(apiEndpoint, deviceId, initialName);
		} catch (err) {
			log.error('Error reporting initial configuration, will retry', err);
			await Bluebird.delay(retryDelay);
			await this.reportInitialConfig(
				apiEndpoint,
				deviceId,
				retryDelay,
				initialName,
			);
		}
	}

	private async exchangeKeyAndGetDevice(
		opts?: KeyExchangeOpts,
	): Promise<Device> {
		if (opts == null) {
			opts = await this.config.get('provisioningOptions');
		}

		const uuid = opts.uuid;
		const apiTimeout = opts.apiTimeout;
		if (!(uuid && apiTimeout)) {
			throw new InternalInconsistencyError(
				'UUID and apiTimeout should be defined in exchangeKeyAndGetDevice',
			);
		}

		// If we have an existing device key we first check if it's
		// valid, becaise of it is we can just use that
		if (opts.deviceApiKey != null) {
			const deviceFromApi = await this.fetchDevice(
				uuid,
				opts.deviceApiKey,
				apiTimeout,
			);
			if (deviceFromApi != null) {
				return deviceFromApi;
			}
		}

		// If it's not valid or doesn't exist then we try to use the
		// user/provisioning api key for the exchange
		if (!opts.provisioningApiKey) {
			throw new InternalInconsistencyError(
				'Required a provisioning key in exchangeKeyAndGetDevice',
			);
		}
		const device = await this.fetchDevice(
			uuid,
			opts.provisioningApiKey,
			apiTimeout,
		);

		if (device == null) {
			throw new ExchangeKeyError(`Couldn't fetch device with provisioning key`);
		}

		// We found the device so we can try to register a working device key for it
		const [res] = await (await request.getRequestInstance())
			.postAsync(`${opts.apiEndpoint}/api-key/device/${device.id}/device-key`, {
				json: true,
				body: {
					apiKey: opts.deviceApiKey,
				},
				headers: {
					Authorization: `Bearer ${opts.provisioningApiKey}`,
				},
			})
			.timeout(apiTimeout);

		if (res.statusCode !== 200) {
			throw new ExchangeKeyError(
				`Couldn't register device key with provisioning key`,
			);
		}

		return device;
	}

	private async exchangeKeyAndGetDeviceOrRegenerate(
		opts?: KeyExchangeOpts,
	): Promise<Device> {
		try {
			const device = await this.exchangeKeyAndGetDevice(opts);
			log.debug('Key exchange succeeded');
			return device;
		} catch (e) {
			if (e instanceof ExchangeKeyError) {
				log.error('Exchanging key failed, re-registering...');
				await this.config.regenerateRegistrationFields();
			}
			throw e;
		}
	}

	private async provision() {
		let device: Device | null = null;
		const opts = await this.config.get('provisioningOptions');
		if (
			opts.registered_at == null ||
			opts.deviceId == null ||
			opts.provisioningApiKey != null
		) {
			if (opts.registered_at != null && opts.deviceId == null) {
				log.debug(
					'Device is registered but no device id available, attempting key exchange',
				);
				device = (await this.exchangeKeyAndGetDeviceOrRegenerate(opts)) || null;
			} else if (opts.registered_at == null) {
				log.info('New device detected. Provisioning...');
				try {
					device = await deviceRegister.register(opts).timeout(opts.apiTimeout);
				} catch (err) {
					if (DuplicateUuidError(err)) {
						log.debug('UUID already registered, trying a key exchange');
						device = await this.exchangeKeyAndGetDeviceOrRegenerate(opts);
					} else {
						throw err;
					}
				}
				opts.registered_at = Date.now();
			} else if (opts.provisioningApiKey != null) {
				log.debug(
					'Device is registered but we still have an apiKey, attempting key exchange',
				);
				device = await this.exchangeKeyAndGetDevice(opts);
			}

			if (!device) {
				// TODO: Type this?
				throw new Error(`Failed to provision device!`);
			}
			const { id } = device;
			if (!this.balenaApi) {
				throw new InternalInconsistencyError(
					'Attempting to provision a device without an initialized API client',
				);
			}
			this.balenaApi.passthrough.headers.Authorization = `Bearer ${opts.deviceApiKey}`;

			const configToUpdate = {
				registered_at: opts.registered_at,
				deviceId: id,
				apiKey: null,
			};
			await this.config.set(configToUpdate);
			this.eventTracker.track('Device bootstrap success');
		}

		// Now check if we need to pin the device
		const pinValue = await this.config.get('pinDevice');

		if (pinValue != null) {
			if (pinValue.app == null || pinValue.commit == null) {
				log.error(
					`Malformed pinDevice fields in supervisor database: ${pinValue}`,
				);
				return;
			}
			log.info('Attempting to pin device to preloaded release...');
			return this.pinDevice(pinValue);
		}
	}

	private async provisionOrRetry(retryDelay: number): Promise<void> {
		this.eventTracker.track('Device bootstrap');
		try {
			await this.provision();
		} catch (e) {
			this.eventTracker.track(`Device bootstrap failed, retrying`, {
				error: e,
				delay: retryDelay,
			});
			await Bluebird.delay(retryDelay);
			return this.provisionOrRetry(retryDelay);
		}
	}

	private async provisionDevice() {
		if (this.balenaApi == null) {
			throw new Error(
				'Trying to provision a device without initializing API client',
			);
		}
		const conf = await this.config.getMany([
			'provisioned',
			'bootstrapRetryDelay',
			'apiKey',
			'pinDevice',
		]);

		if (!conf.provisioned || conf.apiKey != null || conf.pinDevice != null) {
			await this.provisionOrRetry(conf.bootstrapRetryDelay);
			globalEventBus.getInstance().emit('deviceProvisioned');
			return;
		}

		return conf;
	}

	private lockGetTarget() {
		return writeLock('getTarget').disposer(release => {
			release();
		});
	}

	private createAPIBinderRouter(apiBinder: APIBinder): express.Router {
		const router = express.Router();

		router.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
		router.use(bodyParser.json({ limit: '10mb' }));

		router.post('/v1/update', (req, res, next) => {
			apiBinder.eventTracker.track('Update notification');
			if (apiBinder.readyForUpdates) {
				this.config
					.get('instantUpdates')
					.then(instantUpdates => {
						if (instantUpdates) {
							apiBinder
								.getAndSetTargetState(req.body.force, true)
								.catch(_.noop);
							res.sendStatus(204);
						} else {
							log.debug(
								'Ignoring update notification because instant updates are disabled',
							);
							res.sendStatus(202);
						}
					})
					.catch(next);
			} else {
				res.sendStatus(202);
			}
		});

		return router;
	}

	private async reportInitialName(
		deviceId: number,
		name: string,
	): Promise<void> {
		if (this.balenaApi == null) {
			throw new InternalInconsistencyError(
				`Attempt to set an initial device name without an API client`,
			);
		}

		await this.balenaApi.patch({
			resource: 'device',
			id: deviceId,
			body: {
				device_name: name,
			},
		});
	}
}

export default APIBinder;
