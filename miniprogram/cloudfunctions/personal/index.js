const cloud = require("wx-server-sdk");
const { boundedImage } = require("./image");
const { createPersonal } = require("./core");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const store = {
  async transact(owner, update) {
    return db.runTransaction(async (tx) => {
      const ref = tx.collection("music_personal").doc(owner);
      let doc = null;
      try {
        const result = await ref.get();
        doc = result.data;
      } catch (e) {
        if (
          !/not exist|not found|DATABASE_DOCUMENT_NOT_EXIST|does not exist/i.test(
            String(e.errMsg || e.message || ""),
          )
        )
          throw e;
      }
      if (doc) {
        delete doc._id;
        delete doc._openid;
      }
      const next = await update(doc);
      if (next.doc) await ref.set({ data: next.doc });
      return next.result;
    });
  },
};
const storage = {
  async validate(fileID) {
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const url = result.fileList?.[0]?.tempFileURL;
    if (!url) throw new Error("missing avatar");
    await boundedImage(url);
  },
  async remove(fileID) {
    await cloud.deleteFile({ fileList: [fileID] });
  },
};
const handle = createPersonal({ store, storage });
exports.main = (event) => handle(event, cloud.getWXContext());
