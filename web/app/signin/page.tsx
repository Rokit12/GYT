import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export default function SignIn() {
  return <Suspense><AuthForm mode="signin" /></Suspense>;
}
