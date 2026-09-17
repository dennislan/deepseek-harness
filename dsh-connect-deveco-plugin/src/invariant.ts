/**
 * Runtime invariants for `dsh-connect-deveco`.
 *
 * The plugin's observable relationships are already enforced where they are
 * created: the credential reader fails loudly on an undecryptable store, and
 * the adapter's provider metadata is checked by the `llm` registry on
 * registration. There is no independent second observation to compare against
 * one of those facts, so this module exports no installer.
 *
 * @module dsh-connect-deveco/invariant
 */

export {}
