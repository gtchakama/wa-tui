class WaTui < Formula
  desc "Terminal UI for WhatsApp Web"
  homepage "https://github.com/gtchakama/wa-tui"
  url "https://registry.npmjs.org/@gtchakama/wa-tui/-/wa-tui-1.4.4.tgz"
  sha256 "7a0b665178511f0a75fea20bf2ab9c093b1119fc727fc47258f942eec446f46c"
  license "ISC"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_predicate bin/"wa-tui", :executable?
  end
end
