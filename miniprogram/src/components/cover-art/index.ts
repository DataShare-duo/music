Component({
  properties: {
    url: { type: String, value: "" },
    title: { type: String, value: "专辑封面" },
  },
  data: { safeUrl: "", broken: false },
  observers: {
    url(value: string) {
      this.setData({
        safeUrl: value.startsWith("https://") ? value : "",
        broken: false,
      });
    },
  },
  methods: {
    failed() {
      this.setData({ broken: true });
    },
  },
});
