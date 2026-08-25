/**
 * The Earth Engine Node client ships no TypeScript types.
 *
 * Declared as `any` deliberately: EE's client API is a fluent builder that
 * assembles a server-side computation graph, so its call chains cannot be
 * meaningfully typed here. The boundary is kept narrow — everything crossing
 * out of lib/sources/openet.ts is validated and typed before it goes anywhere
 * else.
 */
declare module "@google/earthengine" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ee: any;
  export default ee;
}
