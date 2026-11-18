class TestClock {
  time = 0;
  next = 0;
  tasks = new Map();
  now() {
    return this.time;
  }
  setTimeout(fn, ms) {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(id) {
    this.tasks.delete(id);
  }
  tick(ms) {
    const end = this.time + ms;
    let iterations = 0;
    while (true) {
      const due = [...this.tasks]
        .filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      if (++iterations > 1000) throw new Error("Timer loop");
      this.tasks.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = end;
  }
}
module.exports = { TestClock };
