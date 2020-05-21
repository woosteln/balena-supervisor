import { Router } from 'express';
import { fs } from 'mz';
import { stub } from 'sinon';

import { ApplicationManager } from '../../src/application-manager';
import Config from '../../src/config';
import Database from '../../src/db';
import { createV1Api } from '../../src/device-api/v1';
import { createV2Api } from '../../src/device-api/v2';
import APIBinder from '../../src/api-binder';
import DeviceState from '../../src/device-state';
import EventTracker from '../../src/event-tracker';
import SupervisorAPI from '../../src/supervisor-api';
import { Images } from '../../src/compose/images';
import { ServiceManager } from '../../src/compose/service-manager';
import { NetworkManager } from '../../src/compose/network-manager';
import { VolumeManager } from '../../src/compose/volume-manager';

const DB_PATH = './test/data/supervisor-api.sqlite';
// Holds all values used for stubbing
const STUBBED_VALUES = {
	config: {
		apiSecret: 'secure_api_secret',
		currentCommit: '7fc9c5bea8e361acd49886fe6cc1e1cd',
	},
	services: [
		{
			appId: 1,
			imageId: 1111,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'main',
		},
		{
			appId: 1,
			imageId: 2222,
			status: 'Running',
			releaseId: 99999,
			createdAt: new Date('2020-04-25T04:15:23.111Z'),
			serviceName: 'redis',
		},
		{
			appId: 2,
			imageId: 3333,
			status: 'Running',
			releaseId: 77777,
			createdAt: new Date('2020-05-15T19:33:06.088Z'),
			serviceName: 'main',
		},
	],
	images: [],
	networks: [],
	volumes: [],
};

/**
 * THIS MOCKED API CONTAINS STUBS THAT MIGHT CAUSE UNEXPECTED RESULTS
 * IF YOU WANT TO ADD/MODIFY STUBS THAT INVOLVE API OPERATIONS
 * AND MULTIPLE TEST CASES WILL USE THEM THEN ADD THEM HERE
 * OTHERWISE YOU CAN ADD STUBS ON A PER TEST CASE BASIS
 *
 * EXAMPLE: We stub ApplicationManager so there is atleast 1 running app
 *
 * You can see all the stubbed values convientiely in STUBBED_VALUES.
 *
 */

async function create(): Promise<SupervisorAPI> {
	// Get SupervisorAPI construct options
	const {
		db,
		config,
		eventTracker,
		deviceState,
		apiBinder,
	} = await createAPIOpts();
	// Stub functions
	setupStubs();
	// Create ApplicationManager
	const appManager = new ApplicationManager({
		db,
		config,
		eventTracker,
		logger: null,
		deviceState,
		apiBinder: null,
	});
	// Create SupervisorAPI
	const api = new SupervisorAPI({
		config,
		eventTracker,
		routers: [buildRoutes(appManager)],
		healthchecks: [deviceState.healthcheck, apiBinder.healthcheck],
	});
	// Return SupervisorAPI that is not listening yet
	return api;
}

async function cleanUp(): Promise<void> {
	try {
		// clean up test data
		await fs.unlink(DB_PATH);
	} catch (e) {
		/* noop */
	}
	// Restore created SinonStubs
	return restoreStubs();
}

async function createAPIOpts(): Promise<SupervisorAPIOpts> {
	// Create database
	const db = new Database({
		databasePath: DB_PATH,
	});
	await db.init();
	// Create config
	const mockedConfig = new Config({ db });
	// Initialize and set values for mocked Config
	await initConfig(mockedConfig);
	// Create EventTracker
	const tracker = new EventTracker();
	// Create deviceState
	const deviceState = new DeviceState({
		db,
		config: mockedConfig,
		eventTracker: tracker,
		logger: null as any,
		apiBinder: null as any,
	});
	const apiBinder = new APIBinder({
		db,
		config: mockedConfig,
		eventTracker: tracker,
		logger: null as any,
	});
	return {
		db,
		config: mockedConfig,
		eventTracker: tracker,
		deviceState,
		apiBinder,
	};
}

async function initConfig(config: Config): Promise<void> {
	// Set testing secret
	await config.set({
		apiSecret: STUBBED_VALUES.config.apiSecret,
	});
	// Set a currentCommit
	await config.set({
		currentCommit: STUBBED_VALUES.config.currentCommit,
	});
	// Initialize this config
	return config.init();
}

function buildRoutes(appManager: ApplicationManager): Router {
	// Create new Router
	const router = Router();
	// Add V1 routes
	createV1Api(router, appManager);
	// Add V2 routes
	createV2Api(router, appManager);
	// Return modified Router
	return router;
}

function setupStubs() {
	stub(ServiceManager.prototype, 'getStatus').resolves(STUBBED_VALUES.services);
	stub(Images.prototype, 'getStatus').resolves(STUBBED_VALUES.images);
	stub(NetworkManager.prototype, 'getAllByAppId').resolves(
		STUBBED_VALUES.networks,
	);
	stub(VolumeManager.prototype, 'getAllByAppId').resolves(
		STUBBED_VALUES.volumes,
	);
}

function restoreStubs() {
	(ServiceManager.prototype as any).getStatus.restore();
	(Images.prototype as any).getStatus.restore();
	(NetworkManager.prototype as any).getAllByAppId.restore();
	(VolumeManager.prototype as any).getAllByAppId.restore();
}

interface SupervisorAPIOpts {
	db: Database;
	config: Config;
	eventTracker: EventTracker;
	deviceState: DeviceState;
	apiBinder: APIBinder;
}

export = { create, cleanUp, STUBBED_VALUES };
