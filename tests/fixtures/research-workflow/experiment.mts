export async function run(context) {
  const rows = await context.files.readCsv('measurements.csv');
  const groups = ['A', 'B'].map((group) => {
    const values = rows.filter((row) => row.group === group).map((row) => Number(row.value));
    return { group, mean: context.statistics.mean(values) };
  });
  await context.files.writeCsv('means.csv', groups);
}
