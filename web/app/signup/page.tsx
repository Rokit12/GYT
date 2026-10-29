import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export default function SignUp() {
  return <Suspense><AuthForm mode="signup" /></Suspense>;
}
