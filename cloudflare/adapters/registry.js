const adapterFactories = {
  google_drive: () => import('./google.js'),
  onedrive: () => import('./onedrive.js'),
  dropbox: () => import('./dropbox.js'),
  yandex: () => import('./yandex.js'),
  s3: () => import('./s3.js'),
  pcloud: () => import('./pcloud.js'),
};

const adapterClassNames = {
  google_drive: 'GoogleDriveAdapter',
  onedrive: 'OneDriveAdapter',
  dropbox: 'DropboxAdapter',
  yandex: 'YandexAdapter',
  s3: 'S3Adapter',
  pcloud: 'PCloudAdapter',
};

export async function createAdapter(provider, account, env) {
  const factory = adapterFactories[provider];
  if (!factory) throw new Error(`Unknown provider: ${provider}`);
  const mod = await factory();
  const AdapterClass = mod[adapterClassNames[provider]];
  if (!AdapterClass) throw new Error(`Adapter class not found for provider: ${provider}`);
  return new AdapterClass(account, env);
}

export function isSupportedProvider(provider) {
  return provider in adapterFactories;
}
