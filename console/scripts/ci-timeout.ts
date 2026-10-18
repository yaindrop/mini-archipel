/**
 * The shared quality lifecycle exports MINI_CI_TIMEOUT_FACTOR for every
 * stage: 2 on virtualized fleet nodes, 1 on physical machines. Per-test
 * budgets calibrated on physical nodes must scale with it.
 */
export const scaledTestTimeout = (milliseconds: number): number => {
  const factor = Number(process.env.MINI_CI_TIMEOUT_FACTOR ?? "1");
  return milliseconds * (Number.isFinite(factor) && factor >= 1 ? factor : 1);
};
