/** core 统一门面：宿主层只从这里导入，签名见 src/shared/protocol.ts 头部说明 */
export * from './types.ts';
export { parsePath, compilePath, pathToString } from './pathLang.ts';
export type { PathToken } from './pathLang.ts';
export { parseSed } from './sedDialect.ts';
export type { SedParseResult } from './sedDialect.ts';
export {
  matchScope,
  candidateExtensions,
  scopeToGlob,
  globMatch,
  globToRegExp,
  extOf,
  validateInstruction,
} from './extensionPolicy.ts';
export { parseTreeFilter, matchTreeFilter, describeTreeFilter } from './treeFilter.ts';
export { planJsonc } from './jsoncAdapter.ts';
export { planYaml } from './yamlAdapter.ts';
export { planText } from './textAdapter.ts';
export { mergePatches, detectConflicts, applyPatches, reversePatches } from './merge.ts';
export { planFile, planSession } from './engine.ts';
export type { PlanOptions, SessionFile, SessionPlan } from './engine.ts';
export * from './selection.ts';
