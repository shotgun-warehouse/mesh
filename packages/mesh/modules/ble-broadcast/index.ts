// Re-export the native module. On web, it will be resolved to BleBroadcastModule.web.ts
// and on native platforms to BleBroadcastModule.ts
export { default } from './src/BleBroadcastModule';
export * from './src/BleBroadcast.types';
