import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export const sharedResolve = {
  alias: {
    '@t3-code/runtime-protocol': `${here}packages/runtime-protocol/src/index.ts`,
    '@t3-code/runtime-core': `${here}packages/runtime-core/src/index.ts`,
    '@t3-code/runtime-docker': `${here}packages/runtime-docker/src/index.ts`,
  },
};
