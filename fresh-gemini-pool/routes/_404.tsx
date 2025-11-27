import { Head } from "$fresh/runtime.ts";

export default function Error404() {
  return (
    <>
      <Head>
        <title>404 - Page not found</title>
      </Head>
      <div class="px-4 py-8 mx-auto bg-gray-50 min-h-screen flex items-center justify-center">
        <div class="max-w-screen-md text-center">
          <h1 class="text-4xl font-bold">404 - 页面未找到</h1>
          <p class="my-4">
            您访问的页面不存在。
          </p>
          <a href="/" class="underline text-blue-600">返回首页</a>
        </div>
      </div>
    </>
  );
}
