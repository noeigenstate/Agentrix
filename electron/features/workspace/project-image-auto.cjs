// A project gets one automatic snapshot; a later scan must never undo the user's choice.
function createProjectImageAuto({ getProject, listCandidates, setProjectImage, broadcast }) {
  const attempted = new Set(); let queue = Promise.resolve();
  const eligible = project => project && project.kind !== 'ssh' && !project.image && (!project.imageMode || project.imageMode === 'auto');
  function enqueue(project) {
    if (!eligible(project) || attempted.has(project.id)) return queue;
    const { id, path } = project; attempted.add(id);
    queue = queue.then(() => new Promise(resolve => setImmediate(resolve))).then(async () => {
      const current = getProject(id);
      if (!eligible(current) || current.path !== path) return;
      const image = (await listCandidates(path)).candidates.find(candidate => candidate.source === 'icon')?.image;
      const latest = getProject(id);
      if (!image || !eligible(latest) || latest.path !== path) return;
      setProjectImage(id, image, 'auto'); broadcast();
    }).catch(() => {});
    return queue;
  }
  return { enqueue };
}

module.exports = { createProjectImageAuto };
