export async function inspectPortExample() {
  const portInfo = await window.api.getPortInfo(8080);
  console.log('Port info:', portInfo);

  const httpProbe = await window.api.probeHttp(8080);
  console.log('HTTP probe:', httpProbe);

  if (!portInfo.occupied || !portInfo.primaryRecord?.pid) {
    return;
  }

  const processInfo = await window.api.getProcessInfo(portInfo.primaryRecord.pid);
  console.log('Process info:', processInfo);
}

export async function loadPortListExample() {
  const portList = await window.api.getPortList();
  console.log('Listening ports:', portList);
}

export async function diagnosticsExample(port) {
  const report = await window.api.getDiagnostics(port);
  console.log('Diagnostics report:', report);
}
