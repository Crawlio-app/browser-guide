import Foundation
import XCTest
@testable import BrowserGuideNativeCore

final class NativeMessageFramingTests: XCTestCase {
    func testEncodesLengthAsLittleEndianUInt32() throws {
        let payload = Data(repeating: 0x61, count: 258)
        let frame = try NativeMessageFrameDecoder.encode(payload)

        XCTAssertEqual(Array(frame.prefix(4)), [0x02, 0x01, 0x00, 0x00])
        XCTAssertEqual(Data(frame.dropFirst(4)), payload)
    }

    func testDecodesFragmentedAndAdjacentFrames() throws {
        let first = try NativeMessageFrameDecoder.encode(Data("{\"one\":1}".utf8))
        let second = try NativeMessageFrameDecoder.encode(Data("{\"two\":2}".utf8))
        let stream = first + second
        var decoder = NativeMessageFrameDecoder()
        var decoded: [Data] = []

        decoded += try decoder.append(Data(stream.prefix(2)))
        decoded += try decoder.append(Data(stream.dropFirst(2).prefix(7)))
        decoded += try decoder.append(Data(stream.dropFirst(9)))
        try decoder.finish()

        XCTAssertEqual(decoded, [Data("{\"one\":1}".utf8), Data("{\"two\":2}".utf8)])
    }

    func testRejectsOversizedAndTruncatedFrames() throws {
        var oversized = NativeMessageFrameDecoder(maximumMessageBytes: 8)
        XCTAssertThrowsError(try oversized.append(Data([9, 0, 0, 0]))) { error in
            XCTAssertEqual(error as? NativeMessageFramingError, .messageTooLarge(maximumBytes: 8))
        }

        var truncated = NativeMessageFrameDecoder()
        _ = try truncated.append(Data([4, 0, 0, 0, 0x7b]))
        XCTAssertThrowsError(try truncated.finish()) { error in
            XCTAssertEqual(error as? NativeMessageFramingError, .truncatedFrame)
        }
    }
}
