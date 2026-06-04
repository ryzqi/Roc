import { WebReadService } from '../../services/web-read-service';

export type WebReadAdapterOptions = {
  fetchImpl?: ConstructorParameters<typeof WebReadService>[0];
};

export function createWebReadService(options: WebReadAdapterOptions = {}): WebReadService {
  if (options.fetchImpl !== undefined) {
    return new WebReadService(options.fetchImpl);
  }
  return new WebReadService();
}
