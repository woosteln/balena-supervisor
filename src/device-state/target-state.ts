import type { TargetState } from '../types/state';
import { EventEmitter } from 'events';
import { InternalInconsistencyError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import * as url from 'url';
import Config from '../config';
import DB from '../db';
import type { Headers } from 'request';
import { delay } from 'bluebird';
import constants = require('../lib/constants');
import * as _ from 'lodash';
import { writeLock } from '../lib/update-lock';
import Bluebird = require('bluebird');
import type StrictEventEmitter from 'strict-event-emitter-types';

// TODO: Is there a better way to get a handle on a config instance?
const config = new Config({ db: new DB() });

interface TargetStateEvents {
	'target-state-update': (
		targetState: TargetState,
		force: boolean,
		isFromApi: boolean,
	) => void;
}
export const emitter: StrictEventEmitter<
	EventEmitter,
	TargetStateEvents
> = new EventEmitter();

const lockGetTarget = () =>
	writeLock('getTarget').disposer((release) => release());

let cache: {
	etag?: string | string[];
	body: TargetState;
};

/**
 * The last fetch attempt, success or fail
 */
export let lastFetch: ReturnType<typeof process.hrtime>;
/**
 * Attempts to update the target state
 * @param force Emitted with the 'target-state-update' event update as necessary
 * @param isFromApi Emitted with the 'target-state-update' event update as necessary
 */
export const update = async (
	// TODO: Is there a better way than passing these params here just to emit them if there is an update?
	force = false,
	isFromApi = false,
): Promise<void> => {
	return Bluebird.using(lockGetTarget(), async () => {
		const { uuid, apiEndpoint, apiTimeout } = await config.getMany([
			'uuid',
			'apiEndpoint',
			'apiTimeout',
		]);

		if (typeof apiEndpoint !== 'string') {
			throw new InternalInconsistencyError(
				'Non-string apiEndpoint passed to ApiBinder.getTargetState',
			);
		}

		const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
		const request = await getRequestInstance();

		const params: Headers = {
			json: true,
		};

		if (typeof cache?.etag === 'string') {
			params.headers = {
				'If-None-Match': cache.etag,
			};
		}

		const [{ statusCode, headers }, body] = await request
			.getAsync(endpoint, {
				json: true,
			})
			.timeout(apiTimeout);

		if (statusCode === 304) {
			// There's no change so no need to update the cache or emit a change event
			return;
		}

		cache = {
			etag: headers.etag,
			body,
		};

		emitter.emit('target-state-update', _.cloneDeep(body), force, isFromApi);
	}).finally(() => {
		lastFetch = process.hrtime();
	});
};

let targetStateFetchErrors = 0;
const poll = async (skipFirstGet: boolean = false): Promise<void> => {
	try {
		// TODO: I'd prefer to get this only once and then add an event listener for updates
		const appUpdatePollInterval = await config.get('appUpdatePollInterval');

		// We add a random jitter up to `maxApiJitterDelay` to
		// space out poll requests
		let pollInterval =
			Math.random() * constants.maxApiJitterDelay + appUpdatePollInterval;

		if (!skipFirstGet) {
			try {
				await update();
				targetStateFetchErrors = 0;
			} catch (e) {
				pollInterval = Math.min(
					appUpdatePollInterval,
					15000 * 2 ** targetStateFetchErrors,
				);
				++targetStateFetchErrors;
			}
		}

		await delay(pollInterval);
	} catch {
		// If we failed fetching the config or in some other very unexpected way
		// then wait 10s before retrying, there shouldn't have been any network
		// requests as that is handled by a separate try/catch
		await delay(10000);
	} finally {
		await poll();
	}
};

/**
 * Get the latest target state, attempting a fetch first if we do not already have one
 */
export const get = async (): Promise<TargetState> => {
	if (cache == null) {
		await update();
	}
	return _.cloneDeep(cache.body);
};

/**
 * Start polling for target state updates
 */
export const startPoll = _.once(
	async (): Promise<void> => {
		let instantUpdates;
		try {
			// TODO: this can probably be passed in and potentially remove our dependence on the config instance
			instantUpdates = await config.get('instantUpdates');
		} catch {
			// Default to skipping the initial update if we couldn't fetch the setting
			// which should be the exceptional case
			instantUpdates = false;
		}
		poll(!instantUpdates);
	},
);
