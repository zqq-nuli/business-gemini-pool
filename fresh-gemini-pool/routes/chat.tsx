import { Head } from "$fresh/runtime.ts";
import ChatInterface from "../islands/ChatInterface.tsx";

export default function Chat() {
  return (
    <>
      <Head>
        <title>Business Gemini - 智能对话</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </Head>
      <div class="min-h-screen bg-gray-50">
        <header class="bg-white shadow">
          <div class="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
            <h1 class="text-2xl font-bold text-gray-900">
              Business Gemini
              <span class="text-sm font-normal text-gray-500 ml-4">智能对话</span>
            </h1>
            <a
              href="/"
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              返回管理
            </a>
          </div>
        </header>
        <main class="h-[calc(100vh-80px)]">
          <ChatInterface />
        </main>
      </div>
    </>
  );
}
