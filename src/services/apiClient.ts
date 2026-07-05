import { useApiStore } from '@/store/useApiStore';

/**
 * All API calls are routed through the backend edge function.
 * No direct external API calls from the frontend.
 */
export async function executeApi(serviceAction: string, data: Record<string, unknown> = {}) {
  return useApiStore.getState().execute(serviceAction, data);
}

export function connectService(name: string) {
  return useApiStore.getState().connect(name);
}

export function disconnectService(name: string) {
  return useApiStore.getState().disconnect(name);
}
