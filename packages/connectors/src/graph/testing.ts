import { readFileSync } from 'node:fs';

/**
 * Loads a recorded Graph response from `__fixtures__/graph` (spec 8:
 * "every connector ships recorded responses under `__fixtures__` and
 * tests run against them with `msw`").
 *
 * The recordings are synthetic. Every address is on `example.com` or a
 * subdomain of it and every name is invented, so the fixtures carry no
 * personal data and can live in the repository.
 *
 * Read at call time rather than imported: a JSON import under NodeNext
 * needs an import attribute and pulls the fixtures into the type
 * programme, and these files exist only for tests.
 */
export function graphFixture<T = unknown>(name: string): T {
  const url = new URL(`../../__fixtures__/graph/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}
