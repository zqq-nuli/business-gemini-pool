import { Head } from "$fresh/runtime.ts";
import AccountManager from "../islands/AccountManager.tsx";

export default function Home() {
  return (
    <>
      <Head>
        <title>Business Gemini Pool - 管理控制台</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </Head>
      <div class="min-h-screen bg-gray-50">
        <header class="bg-white shadow">
          <div class="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
            <h1 class="text-3xl font-bold text-gray-900">
              Business Gemini Pool
              <span class="text-sm font-normal text-gray-500 ml-4">管理控制台</span>
            </h1>
          </div>
        </header>
        <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <AccountManager />
        </main>
      </div>
    </>
  );
}
