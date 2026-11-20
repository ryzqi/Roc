export async function observeElectronLoop(app) {
  await app.evaluate(() => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('perf_hooks');
    globalThis.__rocBenchmarkLoop = monitorEventLoopDelay({ resolution: 10 });
    globalThis.__rocBenchmarkLoop.enable();
  });
}

export async function sampleElectronProcesses(app) {
  return await app.evaluate(async ({ app, screen }) => {
    const memory = process.memoryUsage();
    const privateMemory = await process.getProcessMemoryInfo();
    const loop = globalThis.__rocBenchmarkLoop;
    return {
      sampledAt: new Date().toISOString(), mainPid: process.pid, main: memory,
      mainPrivateMemoryBytes: privateMemory.private * 1024,
      footprintBytes: null, ioSurfaceBytes: null, cpu: process.cpuUsage(),
      hostLoadAverage: process.getBuiltinModule('os').loadavg(),
      eventLoopDelay: loop === undefined ? null : {
        p50Ms: loop.percentile(50) / 1e6, p95Ms: loop.percentile(95) / 1e6, maxMs: loop.max / 1e6
      },
      display: screen.getAllDisplays().map(display => ({ size: display.size, scaleFactor: display.scaleFactor })),
      processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, creationTime: metric.creationTime,
        type: metric.type, name: metric.name ?? null, serviceName: metric.serviceName ?? null,
        cpuPercent: metric.cpu.percentCPUUsage, workingSetBytes: metric.memory.workingSetSize * 1024,
        peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
        privateBytes: metric.memory.privateBytes === undefined ? null : metric.memory.privateBytes * 1024 }))
    };
  });
}
