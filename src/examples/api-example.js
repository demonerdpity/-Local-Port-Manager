export async function inspectPortExample() {
  const portInfo = await window.api.getPortInfo(5173);
  console.log('Port info:', portInfo);

  if (!portInfo.occupied || !portInfo.primaryRecord?.pid) {
    return;
  }

  const processInfo = await window.api.getProcessInfo(portInfo.primaryRecord.pid);
  console.log('Process info:', processInfo);
}

export async function killPortOwnerExample(port) {
  const portInfo = await window.api.getPortInfo(port);
  const pid = portInfo.primaryRecord?.pid;

  if (!pid) {
    console.log(`Port ${port} is not occupied.`);
    return;
  }

  const killResult = await window.api.killProcess(pid);
  console.log('Kill result:', killResult);
}
