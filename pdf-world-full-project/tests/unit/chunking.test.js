test("chunk count calculations", () => {
  const size = 11;
  const chunkSize = 4;
  const total = Math.ceil(size/chunkSize);
  expect(total).toBe(3);
});
