import { createElement, Fragment } from 'react';
import type { FunctionComponent, ReactNode } from 'react';

import { defineEntries } from '../server.js';
import type { RenderEntries, GetBuildConfig, GetSsrConfig } from '../server.js';
import { Children, Slot } from '../client.js';
import {
  getComponentIds,
  getInputString,
  parseInputString,
  PARAM_KEY_SKIP,
  SHOULD_SKIP_ID,
} from './common.js';
import type { RouteProps, ShouldSkip } from './common.js';
import { getPathMapping } from '../lib/utils/path.js';
import type { PathSpec } from '../lib/utils/path.js';

const ShoudSkipComponent = ({ shouldSkip }: { shouldSkip: ShouldSkip }) =>
  createElement('meta', {
    name: 'waku-should-skip',
    content: JSON.stringify(shouldSkip),
  });

export function defineRouter(
  getPathConfig: () => Promise<
    Iterable<{ path: PathSpec; isStatic?: boolean }>
  >,
  getComponent: (
    componentId: string, // "**/layout" or "**/page"
    unstable_setShouldSkip: (val?: ShouldSkip[string]) => void,
  ) => Promise<
    | FunctionComponent<RouteProps>
    | FunctionComponent<RouteProps & { children: ReactNode }>
    | { default: FunctionComponent<RouteProps> }
    | { default: FunctionComponent<RouteProps & { children: ReactNode }> }
    | null
  >,
): ReturnType<typeof defineEntries> {
  const pathConfigPromise = getPathConfig().then((pathConfig) =>
    Array.from(pathConfig),
  );
  const existsPath = async (pathname: string) => {
    const pathConfig = await pathConfigPromise;
    return pathConfig.some(({ path: pathSpec }) =>
      getPathMapping(pathSpec, pathname),
    );
  };
  const shouldSkip: ShouldSkip = {};

  const renderEntries: RenderEntries = async (input, searchParams) => {
    const pathname = parseInputString(input);
    if (!existsPath(pathname)) {
      return null;
    }
    const skip = searchParams.getAll(PARAM_KEY_SKIP) || [];
    const componentIds = getComponentIds(pathname);
    const props: RouteProps = { path: pathname, searchParams };
    const entries = (
      await Promise.all(
        componentIds.map(async (id) => {
          if (skip?.includes(id)) {
            return [];
          }
          const mod = await getComponent(id, (val) => {
            if (val) {
              shouldSkip[id] = val;
            } else {
              delete shouldSkip[id];
            }
          });
          const component = mod && 'default' in mod ? mod.default : mod;
          if (!component) {
            return [];
          }
          const element = createElement(
            component as FunctionComponent<RouteProps>,
            props,
            createElement(Children),
          );
          return [[id, element]] as const;
        }),
      )
    ).flat();
    entries.push([
      SHOULD_SKIP_ID,
      createElement(ShoudSkipComponent, { shouldSkip }) as any,
    ]);
    return Object.fromEntries(entries);
  };

  const getBuildConfig: GetBuildConfig = async (
    unstable_collectClientModules,
  ) => {
    const pathConfig = await pathConfigPromise;
    const path2moduleIds: Record<string, string[]> = {};
    for (const { path: pathSpec } of pathConfig) {
      if (pathSpec.some(({ type }) => type !== 'literal')) {
        continue;
      }
      const pathname = '/' + pathSpec.map(({ name }) => name).join('/');
      const input = getInputString(pathname);
      const moduleIds = await unstable_collectClientModules(input);
      path2moduleIds[pathname] = moduleIds;
    }
    const customCode = `
globalThis.__WAKU_ROUTER_PREFETCH__ = (path) => {
  const path2ids = ${JSON.stringify(path2moduleIds)};
  for (const id of path2ids[path] || []) {
    import(id);
  }
};`;
    const buildConfig: {
      pathname: PathSpec;
      isStatic: boolean;
      entries: { input: string; isStatic: boolean }[];
      customCode: string;
    }[] = [];
    for (const { path: pathSpec, isStatic = false } of pathConfig) {
      const entries: (typeof buildConfig)[number]['entries'] = [];
      if (pathSpec.every(({ type }) => type === 'literal')) {
        const pathname = '/' + pathSpec.map(({ name }) => name).join('/');
        const input = getInputString(pathname);
        entries.push({ input, isStatic });
      }
      buildConfig.push({ pathname: pathSpec, isStatic, entries, customCode });
    }
    return buildConfig;
  };

  const getSsrConfig: GetSsrConfig = async (pathname) => {
    if (!(await existsPath(pathname))) {
      return null;
    }
    const componentIds = getComponentIds(pathname);
    const input = getInputString(pathname);
    const body = createElement(
      Fragment,
      null,
      createElement(Slot, { id: SHOULD_SKIP_ID }),
      componentIds.reduceRight(
        (acc: ReactNode, id) => createElement(Slot, { id, fallback: acc }, acc),
        null,
      ),
    );
    return { input, body };
  };

  return { renderEntries, getBuildConfig, getSsrConfig };
}
