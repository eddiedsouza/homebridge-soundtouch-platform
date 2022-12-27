import { AccessoryConfig, GlobalConfig, PresetConfig, SourceConfig, VolumeMode } from './accessory-config';
import { API, APIDiscovery, compactMap, Info, SourceStatus } from 'soundtouch-api';
import { apiNotFoundWithName } from './errors';
import { stringUpperCaseFirst } from './utils';
import { Logging } from "homebridge";
import { BaseDevice, isVerboseInConfigs } from "homebridge-base-platform";

export interface SoundTouchPreset {
    readonly name: string;
    readonly index: number;
}

export interface SoundTouchSource {
    readonly name: string;
    readonly source: string;
    readonly account?: string;
    readonly enabled: boolean;
}

export interface SoundTouchVolumeSettings {
    readonly onValue: number;
    readonly maxValue: number;
    readonly unmuteValue: number;
    readonly mode: VolumeMode;
}

export interface SoundTouchDevice extends BaseDevice {
    readonly api: API;
    readonly model: string;
    readonly verbose: boolean;
    readonly pollingInterval?: number;
    readonly version?: string;
    readonly volumeSettings: SoundTouchVolumeSettings;
    readonly presets: SoundTouchPreset[];
    readonly sources: SoundTouchSource[];
}

export async function searchAllDevices(globalConfig: GlobalConfig, accessoryConfigs: AccessoryConfig[], log: Logging): Promise<SoundTouchDevice[]> {
    const apis = await APIDiscovery.search();
    return Promise.all(apis.map(async (api) => {
        const info = await api.getInfo();
        if (!info) {
            console.error(`Info not found in search all devices`);
        }
        const accessoryConfig = accessoryConfigs.find((ac) => ac.room === info!.name || ac.ip === api.host);
        return _deviceFromApi(api, info!, globalConfig, accessoryConfig || {}, log);
    }));
}

export async function deviceFromConfig(globalConfig: GlobalConfig, accessoryConfig: AccessoryConfig, log: Logging): Promise<SoundTouchDevice | undefined> {
    let api: API | undefined;
    if (accessoryConfig.ip) {
        api = new API(accessoryConfig.ip, accessoryConfig.port);
    } else if (accessoryConfig.room) {
        api = await APIDiscovery.find(accessoryConfig.room);
    }
    if (!api) {
        throw apiNotFoundWithName(accessoryConfig.name || '');
    }
    const apiInfo = await api.getInfo()
    if (!apiInfo) {
        return;
    }
    return _deviceFromApi(api, apiInfo, globalConfig, accessoryConfig, log);

}

async function _deviceFromApi(api: API, info: Info, globalConfig: GlobalConfig, accessoryConfig: AccessoryConfig, log: Logging): Promise<SoundTouchDevice> {
    const displayName = accessoryConfig.name || info.name;
    const isVerbose = isVerboseInConfigs(globalConfig, accessoryConfig);
    const pollingInterval = accessoryConfig.pollingInterval || globalConfig.pollingInterval;
    const acPresets = accessoryConfig.presets || []
    const globalPresets = globalConfig.presets || []
    if (isVerbose) {
        log(`[${displayName}] Found device`);
    }
    const component = info.components.find((c) => c.serialNumber.toLowerCase() === info.deviceId.toLowerCase());
    const presets = await _availablePresets(api, displayName, acPresets, globalPresets, isVerbose ? log : undefined);
    const sources = await _availableSources(api, displayName, accessoryConfig.sources, globalConfig.sources, isVerbose ? log : undefined);
    const globalVolume = globalConfig.volume || {};
    const accessoryVolume = accessoryConfig.volume || {};
    const onValue = globalVolume.onValue || accessoryVolume.onValue;
    return {
        api: api,
        name: displayName,
        id: info.deviceId,
        model: info.type,
        version: component ? component.softwareVersion : undefined,
        verbose: isVerbose,
        pollingInterval: pollingInterval,
        volumeSettings: {
            onValue: onValue || -1,
            maxValue: globalVolume.maxValue || accessoryVolume.maxValue || 100,
            unmuteValue: globalVolume.unmuteValue || accessoryVolume.unmuteValue || onValue || 35,
            mode: globalVolume.mode || accessoryVolume.mode || VolumeMode.lightbulb
        },
        presets: presets,
        sources: sources || []
    };
}

export interface DeviceOnOffListener {
    deviceDidTurnOff(updateOn?: boolean, updateVolume?: boolean): Promise<boolean>;
    deviceDidTurnOn(updateOn?: boolean, updateVolume?: boolean): Promise<boolean>;
}

export async function deviceIsOn(device: SoundTouchDevice): Promise<boolean> {
    const nowPlaying = await device.api.getNowPlaying();
    return nowPlaying?.source !== SourceStatus.standBy;
}

async function _availablePresets(api: API, deviceName: string, accessoryPresets: PresetConfig[], globalPresets: PresetConfig[], log?: Logging): Promise<SoundTouchPreset[]> {
    const presets = (await api.getPresets()) || [];
    // @ts-ignore
    return compactMap(presets, (preset) => {
        const presetConfig = _findConfig((p) => p.index === preset.id, accessoryPresets, globalPresets) || { index: preset.id };
        if (log !== undefined) {
            log(`[${deviceName}] Found preset n°${preset.id} '${preset.contentItem.itemName}' on device`);
        }
        if (presetConfig.enabled === false) {
            return undefined;
        }
        return {
            name: presetConfig.name || preset.contentItem.itemName,
            index: preset.id
        };
    });
}

async function _availableSources(api: API, deviceName: string, accessorySources?: SourceConfig[], globalSources?: SourceConfig[], log?: Logging): Promise<SoundTouchSource[] | undefined> {
    const sources = await api.getSources();
    if (!sources) {
        console.error('No sources found in _availableSources');
        return
    }
    const localSources = sources.items.filter((src) => src.isLocal);
    return localSources.map((ls) => {
        if (log !== undefined) {
            log(`[${deviceName}] Found local source '${ls.source}' with account '${ls.sourceAccount || ''}' on device`);
        }
        const sourceConfig = _findConfig((p) => p.source === ls.source && (p.account !== undefined ? p.account === ls.sourceAccount : true), accessorySources, globalSources) || { source: ls.source };
        return {
            name: sourceConfig.name || `${deviceName} ${ls.name ? ls.name : stringUpperCaseFirst(sourceConfig.source)}`,
            source: sourceConfig.source,
            account: ls.sourceAccount,
            enabled: sourceConfig.enabled !== false
        };
    });
}

function _findConfig<Config>(predicate: (config: Config) => boolean, accessoryConfigs?: Config[], globalConfigs?: Config[]): Config | undefined {
    const config = accessoryConfigs ? accessoryConfigs.find(predicate) : undefined;
    if (config !== undefined) {
        return config;
    }
    return globalConfigs ? globalConfigs.find(predicate) : undefined;
}
