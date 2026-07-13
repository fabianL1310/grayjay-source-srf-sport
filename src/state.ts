let _config: any = null;
let _settings: any = {};

export function setConfig(config: any): void {
  _config = config || {};
}

export function getConfig<T = any>(key?: string): T {
  if (!_config) throw new Error("Config accessed before source.enable() was called");

  if (key) {
    return _config[key];
  }
  return _config;
}

export function setSettings(settings: any): void {
  _settings = settings || {};
}

export function getSettings<T = any>(key?: string): T {
  if (key) {
    return _settings[key];
  }

  return _settings;
}
