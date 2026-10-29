import { Suspense } from "react";
import SignupWizard from "@/components/SignupWizard";

export const metadata = { title: "GYT · Create your account" };

export default function SignUp() {
  return <Suspense><SignupWizard /></Suspense>;
}
